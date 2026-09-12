// Правила вырезания: сырое значение, формы, в которых секрет попадает в журнал
// (percent-encoded, JSON-экранированное, base64/base64url), шаблонные правила (токен бота
// в любом месте строки, личный id рядом с меткой, e-mail) и порядок «от длинного к
// короткому». Тесты пакета целиком — в diagnose.test.ts, здесь чистые правила.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; при провале подставь ещё и path:
// fc.assert(prop, { seed: SEED, path }).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { REDACTED, redact, secretValuesFromEnv } from "./diagnose.ts";

const SEED = 20_260_919;

/** Формы секрета, которые обязаны умереть в пакете. */
function secretForms(secret: string): string[] {
  return [
    // Многострочное значение приезжает в журнал и по строчкам: каждая строка — тоже форма.
    ...secret
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ].filter((form) => form.length > 0);
}

await test("ни одна форма секрета не выживает в тексте (seed 20260919)", () => {
  // Алфавит — вся печатная ASCII (0x21..0x7E), а не только буквы-цифры: base64 обычного
  // текста даёт `+` и `/` лишь тогда, когда третий байт тройки — `>`, `?` или `~`, и на
  // узком алфавите правило base64 невозможно было проверить вовсе (слепая приёмка T21,
  // мутация F: правило удалялось, все тесты оставались зелёными).
  const secretChars = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
    String.fromCharCode(0x21 + i),
  );
  const secretArb = fc.string({
    unit: fc.constantFrom(...secretChars),
    minLength: 4,
    maxLength: 24,
  });

  fc.assert(
    fc.property(
      fc.array(secretArb, { minLength: 1, maxLength: 3 }),
      fc.array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 6 }),
      fc.string({ maxLength: 40 }),
      (secrets, picks, junk) => {
        // Секрет, целиком помещающийся внутрь пометки, неотличим от неё by construction
        // (пометка — тоже текст); тест оговаривает это, а не прячет.
        const real = secrets.filter(
          (secret) =>
            !secretForms(secret).some((form) => REDACTED.includes(form)),
        );
        // Текст СОБИРАЕТСЯ из форм: случайная строка почти никогда не содержит ни
        // base64, ни percent-формы секрета, и проверка держала бы ноль.
        const pieces = real.flatMap((secret) =>
          picks.map(
            (kind) => secretForms(secret)[kind % secretForms(secret).length],
          ),
        );
        const text = `${pieces
          .map((piece, index) => `${junk.slice(index, index + 3)}${piece}`)
          .join(" ")} ${junk}`;

        const out = redact(text, real);
        for (const secret of real) {
          for (const form of secretForms(secret)) {
            assert.ok(
              !out.includes(form),
              `форма ${JSON.stringify(form)} секрета ${JSON.stringify(secret)} выжила в пакете`,
            );
          }
        }
        assert.equal(
          redact(out, real),
          out,
          "повторное вырезание ничего не меняет",
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

await test("токен бота режется и внутри URL, а не только отдельным словом (seed 20260919)", () => {
  const token = "444555666:BBForeignTokenJJJabcdefghijklmnopqrs";
  const text = `GET https://api.telegram.org/bot${token}/sendMessage failed`;

  const out = redact(text, []);
  assert.ok(!out.includes(token), `токен уехал в пакет: ${out}`);
  assert.match(out, /bot<redacted>\/sendMessage/u);
});

await test("секрет режется в percent-encoded, JSON-экранированной и base64 формах", () => {
  const token = "url/LLL+enc=9012";
  const json = 'jsonKKK"quoted"5678secret';
  const b64 = "base64MMM3456secret";

  const out = redact(
    [
      `url=${encodeURIComponent(token)}`,
      `escaped=${JSON.stringify(json).slice(1, -1)}`,
      `blob=${Buffer.from(b64, "utf8").toString("base64")}`,
      `blob-url=${Buffer.from(b64, "utf8").toString("base64url")}`,
    ].join("\n"),
    [token, json, b64],
  );

  for (const form of [
    ...secretForms(token),
    ...secretForms(json),
    ...secretForms(b64),
  ])
    assert.ok(!out.includes(form), `форма выжила: ${form}`);
});

await test("base64-форма с `+` и `/` режется: секрет с `>` и `?`", () => {
  // Секрет, у которого base64 отличается от base64url — тот самый случай, на котором
  // правило base64 нельзя было проверить узким алфавитом (слепая приёмка T21).
  const secret = "B6>4P?USMARKxyz";
  assert.equal(
    Buffer.from(secret, "utf8").toString("base64"),
    "QjY+NFA/VVNNQVJLeHl6",
    "контроль: base64 этой строки содержит `+` и `/`",
  );
  const out = redact(
    [
      `raw ${secret} end`,
      `b64 ${Buffer.from(secret, "utf8").toString("base64")} end`,
      `b64url ${Buffer.from(secret, "utf8").toString("base64url")} end`,
      `url ${encodeURIComponent(secret)} end`,
      `json ${JSON.stringify(secret).slice(1, -1)} end`,
    ].join("\n"),
    [secret],
  );

  for (const form of secretForms(secret))
    assert.ok(!out.includes(form), `форма выжила: ${form}`);
});

await test("строки многострочного значения режутся по отдельности", () => {
  const secret = "multiEEE7890\nmultiFFF1234";
  const out = redact(
    `whole ${secret} | line1 multiEEE7890 | line2 multiFFF1234`,
    [secret],
  );

  assert.ok(!out.includes("multiEEE7890"), out);
  assert.ok(!out.includes("multiFFF1234"), out);
});

await test("chat id рядом с percent-encoded меткой режется без .env", () => {
  const out = redact("https://api.telegram.org/x?chat_id%3D987654321&x=1", []);

  assert.ok(!out.includes("987654321"), out);
});

await test("длинная форма режется раньше короткой (иначе хвост секрета остаётся)", () => {
  // Контрпример слепой приёмки T21: при обратной сортировке от короткого к длинному
  // остаётся хвост `def67890tail` — короткий секрет съедает начало длинного.
  const out = redact("log abc12345def67890tail end", [
    "abc12345",
    "abc12345def67890tail",
  ]);

  assert.equal(out, `log ${REDACTED} end`);
});

await test("шаблонные правила работают без .env: id рядом с меткой и e-mail", () => {
  const out = redact(
    "turn tg:555000111222:43 chat_id=987654321 from=123456789 owner+iva@example.com",
    [],
  );

  assert.ok(!out.includes("555000111222"), out);
  assert.ok(!out.includes("987654321"), out);
  assert.ok(!out.includes("123456789"), out);
  assert.ok(!out.includes("owner+iva@example.com"), out);
  assert.match(out, /tg:<redacted>:43/u);
  assert.match(out, /chat_id=<redacted>/u);
});

await test("режутся только значения ключей с секретным именем, конфиг — нет", () => {
  const values = secretValuesFromEnv({
    TINY_KEY: "xq7",
    TINY_TOKEN: "a1",
    PIN_ID: "42",
    DB_PASSWORD: "p",
    SMTP_PASS: "pp",
    AUTH_SECRET: "s",
    ASSISTANT_BEARER: "b",
    TELEGRAM_API_HASH: "h",
    AGENT_LANGUAGE: "ru",
    CUSTOM_REASONING: "1",
    MODEL_PROVIDER: "codex",
    ASSISTANT_DATA_DIR: "data",
    ASSISTANT_TIMEZONE: "Asia/Almaty",
    SUPPORT_CHAT_URL: "https://t.me/+iva-support",
    TELEGRAM_ALLOWED_USER_IDS: "555, 987654321",
    OLLAMA_API_KEY: "k".repeat(20),
  });

  for (const secret of [
    "xq7",
    "a1",
    "42",
    "p",
    "pp",
    "s",
    "b",
    "h",
    "k".repeat(20),
    "555",
    "987654321",
  ])
    assert.ok(
      values.includes(secret),
      `значение ключа с секретным именем не попало в список: ${secret}`,
    );
  for (const config of [
    "ru",
    "1",
    "codex",
    "data",
    "Asia/Almaty",
    "https://t.me/+iva-support",
  ])
    assert.ok(
      !values.includes(config),
      `конфиг вырезается как секрет: ${config}`,
    );
});
