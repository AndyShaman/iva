/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Таблица фактов расписаний (T20 п.1): запись, ротация 7 дней, ack, хвост без секретов.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("чужой корень файла — ошибка, битые строки пропускаются", async () => {
  const file = jobFactsFile(dir());
  writeFileSync(file, JSON.stringify({ runs: [] }));
  await assert.rejects(readFacts(file), /not a job facts array/u);
  writeFileSync(file, JSON.stringify([fact(), { name: 42 }, null, "junk"]));
  assert.equal((await readFacts(file)).length, 1);
  writeFileSync(file, "{");
  assert.throws(() => readFactsSync(file), /damaged/u);
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
