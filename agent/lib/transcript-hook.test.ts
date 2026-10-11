/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Хук транскрипта (agent/hooks/transcript.ts): финальный ответ Ивы идёт в дневной файл
// Vault, а ответ планового хода Watch или Brief `QUIET` («писать не о чем») — нет. Тест лежит
// в agent/lib: eve считает хуком каждый файл в agent/hooks (см. trace-hook.test.ts).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const vault = mkdtempSync(join(tmpdir(), "iva-transcript-hook-"));
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.ASSISTANT_TIMEZONE = "UTC";
after(() => rmSync(vault, { recursive: true, force: true }));
await import("../../scripts/lib/ts-esm-hooks.ts");
const hook = (await import("../hooks/transcript.ts")).default as unknown as {
  events: Record<
    string,
    (
      event: { data: Record<string, unknown> },
      ctx: { channel: { kind?: string } },
    ) => void
  >;
};
const completed = (
  message: string,
  finishReason = "stop",
  kind = "channel:telegram",
) =>
  hook.events["message.completed"]?.(
    { data: { message, finishReason } },
    { channel: { kind } },
  );

const daily = () => {
  const dir = join(vault, "daily");
  return existsSync(dir)
    ? readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("")
    : "";
};

test("QUIET after trim is not written to the day; an ordinary reply is", () => {
  completed("QUIET");
  completed("  QUIET\n");
  completed("");
  assert.equal(daily(), "");
  completed("Иван ждёт ответа.\n<!-- iva:next -->\nВторое");
  assert.match(daily(), /\[iva\]\nИван ждёт ответа\./u);
  completed("QUIET, но не совсем");
  assert.match(daily(), /QUIET, но не совсем/u);
  assert.equal(daily().match(/## \d\d:\d\d \[iva\]/gu)?.length, 2);
});

test("an intermediate step before a tool call is still skipped", () => {
  const before = daily();
  completed("думаю…", "tool-calls");
  assert.equal(daily(), before);
});

test("a reply the owner never received is not written: API, child and channel-less sessions", () => {
  const before = daily();
  completed("Отчёт скрипта: NOTHING", "stop", "http");
  completed("Ответ дочерней сессии", "stop", "subagent");
  hook.events["message.completed"]?.(
    { data: { message: "Без канала", finishReason: "stop" } },
    { channel: {} },
  );
  assert.equal(daily(), before);
  completed("Ответ в чат владельца");
  assert.match(daily(), /Ответ в чат владельца/u);
});
