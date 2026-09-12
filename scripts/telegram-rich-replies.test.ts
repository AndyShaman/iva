// TELEGRAM_RICH_REPLIES: auto (прежнее поведение) | never (ответы в текущем чате
// всегда HTML/plain). Здесь оба пути и отказ старта на кривом значении.
/* eslint-disable @typescript-eslint/require-await -- двойник хендла повторяет асинхронную границу eve. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
  TelegramApiResponse,
  TelegramHandle,
} from "eve/channels/telegram";
import { sendThroughOutbox } from "../agent/lib/outbox.ts";
import { richRepliesMode } from "../agent/lib/telegram-rich-replies.ts";

const vault = mkdtempSync(join(tmpdir(), "iva-rich-replies-"));
const dataDir = mkdtempSync(join(tmpdir(), "iva-rich-replies-data-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = `bot-${randomUUID()}`;
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = `webhook-${randomUUID()}`;
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
process.env.AGENT_LANGUAGE = "en";

after(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// Разметка rich-конструкции: таблица уходит rich-сообщением, когда шов её видит.
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

type SentBody = { readonly parse_mode?: string; readonly text?: string };
type ApiCall =
  | { readonly kind: "request"; readonly method: string }
  | { readonly kind: "post"; readonly body: SentBody };

// Двойник хендла eve: помнит вызовы Bot API, отвечает успехом.
function telegramDouble() {
  const calls: ApiCall[] = [];
  const tg: Pick<
    TelegramHandle,
    "chatId" | "messageThreadId" | "request" | "post"
  > = {
    chatId: "1",
    messageThreadId: undefined,
    request: async (method): Promise<TelegramApiResponse> => {
      calls.push({ kind: "request", method });
      return { ok: true, status: 200, body: {} };
    },
    post: async (body) => {
      calls.push({
        kind: "post",
        body: typeof body === "string" ? { text: body } : { ...body },
      });
      return { id: "1", raw: {} };
    },
  };
  return { calls, tg };
}

const callLine = (call: ApiCall) =>
  call.kind === "request"
    ? `request:${call.method}`
    : `post:${String(call.body.parse_mode ?? "")}`;

void test("richRepliesMode: auto по умолчанию, never по значению, мусор — ошибка с именем переменной", () => {
  assert.equal(richRepliesMode(undefined), "auto");
  assert.equal(richRepliesMode("auto"), "auto");
  assert.equal(richRepliesMode("never"), "never");

  for (const raw of ["", " ", "Never", "NEVER", "always", "false", "0"]) {
    assert.throws(
      () => richRepliesMode(raw),
      (error: Error) =>
        error.message.includes("TELEGRAM_RICH_REPLIES") &&
        error.message.includes(JSON.stringify(raw)),
      `richRepliesMode(${JSON.stringify(raw)}) обязан отказывать`,
    );
  }
});

void test("кривое TELEGRAM_RICH_REPLIES валит старт", () => {
  const run = (value: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/lib/ts-esm-hooks.ts",
        "--input-type=module",
        "--eval",
        'import("./agent/lib/telegram-rich-replies.ts")',
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, TELEGRAM_RICH_REPLIES: value },
      },
    );

  const broken = run("always");
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /TELEGRAM_RICH_REPLIES/);

  // Контроль: значение из списка импортируется молча — иначе тест держит ноль.
  const allowed = run("never");
  assert.equal(allowed.status, 0, allowed.stderr);
});

void test("never: таблица уходит HTML, auto: rich", async () => {
  // Спецификатор в переменной — как в scripts/telegram-reply-context.test.ts.
  const telegramModule = "../agent/channels/telegram.ts?rich-replies-test";
  const { outboxTransport } = (await import(
    telegramModule
  )) as typeof import("../agent/channels/telegram.ts");

  const off = telegramDouble();
  const plainPath = outboxTransport(off.tg, "never");
  assert.equal("sendRich" in plainPath, false);
  const offResult = await sendThroughOutbox(TABLE, plainPath);
  assert.equal(offResult.ok, true);
  assert.equal(offResult.delivered, 1);
  assert.equal(
    off.calls.filter((call) => call.kind === "request").length,
    0,
    "never не должен звать sendRichMessage",
  );
  assert.equal(
    off.calls.filter((call) => call.kind === "post").length,
    1,
    "never шлёт ровно один post",
  );
  assert.deepEqual(off.calls.map(callLine), ["post:HTML"]);

  const on = telegramDouble();
  const richPath = outboxTransport(on.tg, "auto");
  const onResult = await sendThroughOutbox(TABLE, richPath);
  assert.equal(onResult.ok, true);
  assert.equal(onResult.delivered, 1);
  assert.equal(
    on.calls.filter((call) => call.kind === "post").length,
    0,
    "auto не должен идти HTML-путём",
  );
  assert.equal(
    on.calls.filter((call) => call.kind === "request").length,
    1,
    "auto шлёт ровно один sendRichMessage",
  );
  assert.deepEqual(on.calls.map(callLine), ["request:sendRichMessage"]);
});
