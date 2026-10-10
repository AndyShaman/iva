/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проводка канала: текст шага модели перед вызовом инструментов (finishReason "tool-calls")
// правит статус хода на месте, ответ модели уходит отдельным сообщением, как раньше, а ход
// без промежуточного текста зовёт Bot API байт в байт прежним образом. Двойник — fetch:
// здесь видно тело запроса таким, каким его получает Telegram.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-status-progress-wire-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "status-progress-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "status-progress-secret";
process.env.TELEGRAM_RICH_REPLIES = "auto";

type ApiCall = { method: string; body: Record<string, unknown> | undefined };
type Handler = (data: Record<string, unknown>, context: unknown) => unknown;
type Adapter = {
  state?: Record<string, unknown>;
  createAdapterContext: (base: {
    ctx: unknown;
    session: {
      id: string;
      auth: { current: null; initiator: null };
      continuation: { token: string; rekey: (token: string) => void };
    };
    state: Record<string, unknown>;
  }) => unknown;
  "message.completed": Handler;
  "turn.cancelled": Handler;
};

const apiCalls: ApiCall[] = [];
globalThis.fetch = (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
  const method = new URL(String(url)).pathname.split("/").at(-1) ?? "";
  apiCalls.push({
    method,
    body: init.body
      ? (JSON.parse(
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
          String(init.body),
        ) as Record<string, unknown>)
      : undefined,
  });
  return Promise.resolve(
    Response.json({
      ok: true,
      result: { message_id: 1, chat: { id: 1, type: "private" } },
    }),
  );
};

// Спецификатор в переменной — как в scripts/telegram-failure-events.test.ts: свой экземпляр
// канала на файл.
const telegramTestModule = "../agent/channels/telegram.ts?status-progress-test";
const [
  { default: channel },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import(telegramTestModule) as Promise<
    typeof import("../agent/channels/telegram.ts")
  >,
  import("#lib/run-status.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
const adapter = (channel as unknown as { adapter: Adapter }).adapter;

after(() => rmSync(dataDir, { recursive: true, force: true }));

const LOADER = '<tg-emoji emoji-id="5818797194127346654">💬</tg-emoji>';
const STOP_BUTTON =
  '<tg-button type="callback_data" style="danger" data="iva_cancel">⏹</tg-button>';

// Ход сессии, каким его оставил turn.started: running, сессия, статус-сообщение.
function startTurn(chatId: string, sessionId: string, messageId?: number) {
  setChatStatus(chatKeyOf(chatId), {
    status: "running",
    sessionId,
    turnId: "turn_1",
    statusMessageId: messageId ?? null,
  });
}

async function emit(
  event: "message.completed" | "turn.cancelled",
  data: Record<string, unknown>,
  { chatId, sessionId }: { chatId: string; sessionId: string },
) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_1", sequence: 0 },
  });
  const context = adapter.createAdapterContext({
    ctx,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: { token: `telegram:${chatId}::`, rekey() {} },
    },
    state: {
      ...adapter.state,
      chatId,
      chatType: "private",
      messageThreadId: null,
    },
  });
  await contextStorage.run(ctx, () => adapter[event](data, context));
}

const step = (finishReason: string, message: string | null) => ({
  finishReason,
  message,
  sequence: 1,
  stepIndex: 0,
  turnId: "turn_1",
});

test("текст перед вызовом инструментов правит статус на месте — так он выглядит на проводе", async () => {
  const chat = { chatId: "811", sessionId: "s-811" };
  startTurn(chat.chatId, chat.sessionId, 500);
  const before = apiCalls.length;

  await emit(
    "message.completed",
    step(
      "tool-calls",
      "<!-- iva:silent -->\nСобираю черновики: суммы и реквизиты оставлю пустыми полями. Минуту.",
    ),
    chat,
  );

  assert.deepEqual(apiCalls.slice(before), [
    {
      method: "editMessageText",
      body: {
        chat_id: "811",
        message_id: 500,
        rich_message: {
          markdown: `${LOADER} Собираю черновики: суммы и реквизиты оставлю пустыми полями. Минуту. ${STOP_BUTTON}`,
        },
      },
    },
  ]);
});

test("ответ модели по-прежнему уходит отдельным сообщением, статус — своя правка", async () => {
  const chat = { chatId: "812", sessionId: "s-812" };
  startTurn(chat.chatId, chat.sessionId, 501);
  const before = apiCalls.length;

  await emit("message.completed", step("tool-calls", "Ищу в почте."), chat);
  await emit("message.completed", step("stop", "Нашла два письма."), chat);

  const calls = apiCalls.slice(before);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["editMessageText", "sendMessage"],
  );
  assert.equal(calls[1].body?.text, "Нашла два письма.");
  assert.equal(calls[1].body?.message_id, undefined);
});

test("секрет в тексте шага вырезан до провода", async () => {
  const chat = { chatId: "813", sessionId: "s-813" };
  startTurn(chat.chatId, chat.sessionId, 502);
  const key = `sk-ant-api03-${"Zx9_".repeat(12)}`;
  const before = apiCalls.length;

  await emit("message.completed", step("tool-calls", `Ключ ${key}`), chat);

  const wire = JSON.stringify(apiCalls.slice(before));
  assert.equal(wire.includes(key.slice(0, 16)), false, wire);
  assert.match(wire, /REDACTED/u);
});

test("ход без промежуточного текста: вызовы Bot API прежние байт в байт", async () => {
  const chat = { chatId: "814", sessionId: "s-814" };
  startTurn(chat.chatId, chat.sessionId, 503);
  const before = apiCalls.length;

  await emit("message.completed", step("tool-calls", null), chat);
  await emit("message.completed", step("tool-calls", ""), chat);
  await emit("message.completed", step("stop", "Готово."), chat);
  await emit("turn.cancelled", { turnId: "turn_1", sequence: 2 }, chat);

  assert.deepEqual(apiCalls.slice(before), [
    {
      method: "sendMessage",
      body: { chat_id: "814", text: "Готово.", parse_mode: "HTML" },
    },
    {
      method: "editMessageText",
      body: {
        chat_id: "814",
        message_id: 503,
        rich_message: {
          markdown:
            "⏹ Stopped. I'll hold new messages and handle them together with the next one.",
        },
      },
    },
  ]);
  assert.equal(getChatStatus(chatKeyOf(chat.chatId))?.status, "idle");
});

test("нет статус-сообщения — текст шага Bot API не трогает", async () => {
  const chat = { chatId: "815", sessionId: "s-815" };
  startTurn(chat.chatId, chat.sessionId);
  const before = apiCalls.length;

  await emit("message.completed", step("tool-calls", "Ищу."), chat);
  await emit("message.completed", step("tool-calls", "   \n  "), chat);

  assert.deepEqual(apiCalls.slice(before), []);
});

test("отмена после фразы: статус переписан на «Остановлено», правок после нет", async () => {
  const chat = { chatId: "816", sessionId: "s-816" };
  startTurn(chat.chatId, chat.sessionId, 504);
  const before = apiCalls.length;

  await emit("message.completed", step("tool-calls", "Копирую образцы."), chat);
  await emit("message.completed", step("tool-calls", "Ещё минуту."), chat);
  await emit("turn.cancelled", { turnId: "turn_1", sequence: 3 }, chat);
  await emit("message.completed", step("tool-calls", "Поздняя фраза."), chat);

  const calls = apiCalls.slice(before);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["editMessageText", "editMessageText"],
  );
  const markdown = (call: ApiCall) =>
    (call.body?.rich_message as { markdown: string }).markdown;
  assert.ok(markdown(calls[0]).includes(" Копирую образцы. "));
  assert.match(markdown(calls[1]), /^⏹ Stopped/u);
});
