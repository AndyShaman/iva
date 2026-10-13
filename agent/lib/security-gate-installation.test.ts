import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { scanOutbound } from "./security-gate.ts";
import {
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";

const env = {
  ASSISTANT_BEARER: "fixtureBearerValueWithoutPrefix",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "fixtureWebhookValueWithoutPrefix",
  OLLAMA_API_KEY: "fixtureOllamaValueWithoutPrefix",
  DEEPGRAM_API_KEY: "fixtureDeepgramValueWithoutPrefix",
  TELEGRAM_API_HASH: "fixtureTelegramHashWithoutPrefix",
};
function fixture(t: test.TestContext) {
  for (const [name, value] of Object.entries(env)) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}
await test("installation secrets are gated bare, in code and Markdown tables", async (t) => {
  fixture(t);
  for (const [name, value] of Object.entries(env)) {
    for (const [index, input] of [
      value,
      `\`\`\`\n${value}\n\`\`\``,
      `| ${name} | ${value} |`,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ].entries()) {
      await t.test(`${name} carrier ${index}`, () => {
        assert.notEqual(redact(input, secretValuesFromEnv(env)), input);
        const output = scanOutbound(input);
        assert.equal(output.clean, false, `${name}: secret passed`);
        assert.equal(output.text.includes(value), false);
        assert.equal(scanOutbound(input, false).text, input);
      });
    }
  }
});
await test("ordinary replies survive installation-secret checks (seed 101301)", (t) => {
  fixture(t);
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "Привет",
          "готово",
          "файл",
          "123",
          "a@b.example",
          "https://example.com",
          "модель",
          "дата",
          "🙂",
        ),
        { maxLength: 50 },
      ),
      (words) => {
        const text = words.join(" ");
        assert.equal(scanOutbound(text).clean, true);
        assert.equal(scanOutbound(text).text, text);
      },
    ),
    { seed: 101301, numRuns: 300 },
  );
});
