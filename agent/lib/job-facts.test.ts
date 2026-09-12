/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Таблица фактов расписаний (T20 п.1): запись, ротация 7 дней, ack, хвост без секретов.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JOB_FACT_RETENTION_MS,
  ackFacts,
  jobFactsFile,
  jobTail,
  latestFact,
  parseFacts,
  readFacts,
  readFactsSync,
  recordFact,
  recordWake,
  type JobFact,
} from "./job-facts.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

function dir(): string {
  return mkdtempSync(join(tmpdir(), "t20-facts-"));
}

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-daily",
    startedAt: NOW - 1000,
    finishedAt: NOW,
    ok: true,
    error: null,
    exitCode: 0,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

test("факт записывается и читается обратно", async () => {
  const file = jobFactsFile(dir());
  await recordFact(file, fact({ name: "digest", tail: "строка журнала" }), NOW);
  const facts = await readFacts(file);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.name, "digest");
  assert.equal(facts[0]?.tail, "строка журнала");
  assert.equal(facts[0]?.acked, false);
  assert.equal(readFactsSync(file).length, 1);
});

test("ротация: строки старше 7 дней удаляются при записи", async () => {
  const file = jobFactsFile(dir());
  await recordFact(
    file,
    fact({
      startedAt: NOW - JOB_FACT_RETENTION_MS - DAY - 1000,
      finishedAt: NOW - JOB_FACT_RETENTION_MS - DAY,
    }),
    NOW,
  );
  await recordFact(
    file,
    fact({ startedAt: NOW - DAY - 1000, finishedAt: NOW - DAY }),
    NOW,
  );
  await recordFact(
    file,
    fact({ name: "digest", startedAt: NOW - 1000, finishedAt: NOW }),
    NOW,
  );
  const facts = await readFacts(file);
  assert.deepEqual(
    facts.map((entry) => entry.name),
    ["memory-daily", "digest"],
  );
});

test("ack закрывает последний провал имени и только его", async () => {
  const file = jobFactsFile(dir());
  await recordFact(
    file,
    fact({ ok: false, error: "exited 1", finishedAt: NOW - 1000 }),
    NOW,
  );
  await recordFact(file, fact({ ok: true, finishedAt: NOW }), NOW);
  await recordFact(
    file,
    fact({ name: "digest", ok: false, error: "exited 2", finishedAt: NOW - 1 }),
    NOW,
  );
  assert.equal(
    await ackFacts(file, "memory-daily"),
    0,
    "успех закрывать нечего",
  );
  assert.equal(await ackFacts(file, "missing"), 0);
  assert.equal(await ackFacts(file, "digest"), 1);
  assert.equal(await ackFacts(file, "digest"), 0, "повтор не считает");
  const facts = await readFacts(file);
  assert.equal(facts.find((entry) => entry.name === "digest")?.acked, true);
});

test("исход хода агента приписывается строке запуска", async () => {
  const file = jobFactsFile(dir());
  await recordFact(file, fact(), NOW);
  assert.equal(
    await recordWake(file, "memory-daily", NOW - 1000, {
      at: NOW + 5,
      status: "empty",
      error: null,
    }),
    true,
  );
  assert.equal(
    await recordWake(file, "memory-daily", NOW - 999, {
      at: NOW + 5,
      status: "failed",
      error: null,
    }),
    false,
    "чужой startedAt не трогаем",
  );
  const [row] = await readFacts(file);
  assert.equal(row?.wake?.status, "empty");
});

test("две записи подряд не теряются (лок)", async () => {
  const file = jobFactsFile(dir());
  await Promise.all([
    recordFact(file, fact({ name: "one" }), NOW),
    recordFact(file, fact({ name: "two" }), NOW),
  ]);
  const names = (await readFacts(file)).map((entry) => entry.name).sort();
  assert.deepEqual(names, ["one", "two"]);
});

test("хвост: последние 20 строк, секреты вырезаны", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "123456789:AAFakeTelegramTokenValue123456789",
    CUSTOM_API_KEY: "sk-verysecretvalue",
    PATH: "/usr/bin",
  };
  const text = [
    ...Array.from({ length: 25 }, (_, index) => `line-${index}`),
    "token=123456789:AAFakeTelegramTokenValue123456789",
    "key=sk-verysecretvalue",
  ].join("\n");
  const tail = jobTail(text, env);
  const lines = tail.split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "line-7");
  assert.ok(!tail.includes("sk-verysecretvalue"), "значение ключа осталось");
  assert.ok(!tail.includes("AAFakeTelegramTokenValue"), "токен остался");
  assert.ok(tail.includes("<redacted>"));
});

test("хвост режет токен внутри bot<token> и пароль из ключа без приметы", () => {
  // Две формы из слепой приёмки T20: токен стоит внутри `bot<token>` в URL Bot API (границы
  // слова его не ловили), а пароль лежит в значении ключа `CUSTOM_BASE_URL` — в имени ключа
  // нет ни KEY, ни TOKEN, ни PASSWORD, и прежний список примет его не видел.
  const token = "1234567890:AAF3xK9mQ7vR2sT5uW8yZ1bC4dE6fG0hI2j";
  const env = {
    TELEGRAM_BOT_TOKEN: "совсем другое значение",
    CUSTOM_BASE_URL: "https://buser:bpass1111@api.example.com/v1",
  };
  const tail = jobTail(
    [
      `GET https://api.telegram.org/bot${token}/sendMessage 401 failed`,
      "provider rejected https://buser:bpass1111@api.example.com/v1 end",
      "upstream said password bpass1111 is wrong",
    ].join("\n"),
    env,
  );
  assert.ok(!tail.includes(token), "токен внутри bot<token> остался в хвосте");
  assert.ok(
    !tail.includes("bpass1111"),
    "пароль из значения .env остался в хвосте",
  );
  assert.ok(tail.includes("<redacted>"));
});

test("чужой корень файла — ошибка, битые строки пропускаются", async () => {
  const file = jobFactsFile(dir());
  writeFileSync(file, JSON.stringify({ runs: [] }));
  await assert.rejects(readFacts(file), /not a job facts array/u);
  writeFileSync(file, JSON.stringify([fact(), { name: 42 }, null, "junk"]));
  assert.equal((await readFacts(file)).length, 1);
  writeFileSync(file, "{");
  assert.throws(() => readFactsSync(file), /damaged/u);
});

test("чужой корень: файл в карантин, факт записан, таблица лечится", async () => {
  // Слепая приёмка T20: валидный JSON, но не массив (агенту велено «вернуть массив строк»,
  // и он может записать объект). Раньше recordFact бросал, факт терялся, а файл не лечился
  // никогда — значит и пробуждение не запускалось ни разу.
  const directory = dir();
  const file = jobFactsFile(directory);
  writeFileSync(file, JSON.stringify({ "memory-daily": { ok: true } }));

  await recordFact(file, fact({ ok: false, error: "exited 1" }), NOW);

  const written = await readFacts(file);
  assert.equal(written.length, 1, "факт после карантина потерян");
  assert.equal(written[0]?.error, "exited 1");
  const quarantined = readdirSync(directory).filter((name) =>
    name.includes("jobs.json.corrupt-"),
  );
  assert.equal(
    quarantined.length,
    1,
    `нет карантина: ${readdirSync(directory).join(", ")}`,
  );
});

test("битый JSON: первый же факт не теряется", async () => {
  // Слепая приёмка T20 (F3): loadJsonStrict откладывал файл и бросал, и первый факт после
  // порчи пропадал вместе с пробуждением. Теперь запись идёт в свежую таблицу.
  const file = jobFactsFile(dir());
  writeFileSync(file, '[{"name":"memory-daily"');

  await recordFact(file, fact({ ok: true, error: null }), NOW);

  const written = await readFacts(file);
  assert.equal(written.length, 1, "факт после битого JSON потерян");
  assert.equal(written[0]?.ok, true);
});

test("битая строка: копия в карантин и строка в журнале, не тишина", async () => {
  // Проверка T20 (раунд 3): одна повреждённая запись (например, провал с битым wake)
  // исчезала молча вместе с фактом провала. Живые строки остаются, битая — в карантине.
  const directory = dir();
  const file = jobFactsFile(directory);
  const good = fact({ name: "digest", ok: true, error: null, exitCode: 0 });
  writeFileSync(
    file,
    JSON.stringify([good, { ...fact({ ok: false }), wake: { at: "вчера" } }]),
  );
  const lines: string[] = [];
  assert.equal(
    parseFacts(JSON.parse(readFileSync(file, "utf8")), file, (line) =>
      lines.push(line),
    ).length,
    1,
  );
  assert.match(lines.join(" "), /1 row/u, "журнал молчит о пропущенной строке");

  await recordFact(file, fact({ name: "memory-daily" }), NOW);

  const written = await readFacts(file);
  assert.deepEqual(
    written.map((row) => row.name),
    ["digest", "memory-daily"],
    "живые строки и новый факт",
  );
  assert.equal(
    readdirSync(directory).filter((name) => name.includes("jobs.json.corrupt-"))
      .length,
    1,
    `нет копии в карантине: ${readdirSync(directory).join(", ")}`,
  );
});

test("latestFact берёт последнюю строку имени по finishedAt", () => {
  const older = fact({ finishedAt: NOW - 100 });
  const newer = fact({ finishedAt: NOW });
  assert.equal(latestFact([older, newer], "memory-daily"), newer);
  assert.equal(latestFact([newer, older], "memory-daily"), newer);
  assert.equal(latestFact([], "memory-daily"), null);
});

test("parseFacts пропускает строку с отрицательным интервалом", () => {
  assert.equal(
    parseFacts([fact({ startedAt: NOW, finishedAt: NOW - 1 })], "x").length,
    0,
  );
  assert.equal(parseFacts([fact()], "x").length, 1);
});
