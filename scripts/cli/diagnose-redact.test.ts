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
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ].filter((form) => form.length > 0);
}

await test("ни одна форма секрета не выживает в тексте (seed 20260919)", () => {
  // Алфавит секрета — тот же, что у ключей и паролей: буквы, цифры и знаки, которыми
  // значение попадает в URL и JSON. Четыре знака — нижняя граница правила «длиннее трёх».
  const secretChars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.+=/@%";
  const secretArb = fc.string({
    unit: fc.constantFrom(...secretChars.split("")),
    minLength: 4,
    maxLength: 24,
  });

  fc.assert(
    fc.property(
      fc.string({ maxLength: 120 }),
      fc.array(secretArb, { minLength: 1, maxLength: 4 }),
      (text, secrets) => {
        // Секрет, целиком помещающийся внутрь пометки, неотличим от неё by construction
        // (пометка — тоже текст); тест оговаривает это, а не прячет.
        const real = secrets.filter(
          (secret) =>
            !secretForms(secret).some((form) => REDACTED.includes(form)),
        );
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

await test("короткие значения ключей со секретным именем режутся, конфиг — нет", () => {
  const values = secretValuesFromEnv({
    TINY_KEY: "xq7",
    TINY_TOKEN: "a1",
    PIN_ID: "42",
    AGENT_LANGUAGE: "ru",
    CUSTOM_REASONING: "1",
    MODEL_PROVIDER: "codex",
    TELEGRAM_ALLOWED_USER_IDS: "555, 987654321",
    OLLAMA_API_KEY: "k".repeat(20),
  });

  assert.ok(
    values.includes("xq7"),
    "значение ключа с именем KEY обязано резаться",
  );
  assert.ok(
    values.includes("a1"),
    "значение ключа с именем TOKEN обязано резаться",
  );
  assert.ok(
    values.includes("42"),
    "значение ключа с именем ID обязано резаться",
  );
  assert.ok(
    values.includes("codex"),
    "значение длиннее трёх знаков режется всегда",
  );
  assert.ok(values.includes("555") && values.includes("987654321"));
  assert.ok(values.includes("k".repeat(20)));
  assert.ok(!values.includes("ru"), "два знака без секретного имени — конфиг");
  assert.ok(!values.includes("1"), "один знак без секретного имени — конфиг");
});
