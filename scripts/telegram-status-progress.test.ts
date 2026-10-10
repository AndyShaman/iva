/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проводка канала: текст шага модели перед вызовом инструментов (finishReason "tool-calls")
// правит статус хода на месте, ответ модели уходит отдельным сообщением, как раньше, а ход
// без промежуточного текста зовёт Bot API байт в байт прежним образом. Двойник — fetch:
// здесь видно тело запроса таким, каким его получает Telegram.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

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
// Ответ Telegram на вызов; null — обычный успех. Тест лимита ставит свой.
let telegramReply: (call: ApiCall) => Response | null = () => null;
globalThis.fetch = (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
  const method = new URL(String(url)).pathname.split("/").at(-1) ?? "";
  const call = {
    method,
    body: init.body
      ? (JSON.parse(
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever eve passes.
          String(init.body),
        ) as Record<string, unknown>)
      : undefined,
  };
  apiCalls.push(call);
  return Promise.resolve(
    telegramReply(call) ??
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
const trace = await import("#lib/trace.ts");

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(trace.traceFilePath(trace.traceDay(), dataDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

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
  {
    chatId,
    sessionId,
    chatType = "private",
  }: { chatId: string; sessionId: string; chatType?: string },
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
      chatType,
      messageThreadId: null,
    },
  });
  await contextStorage.run(ctx, () => adapter[event](data, context));
  // Правку статуса шаг не ждёт: запрос уходит следом, и тест смотрит на провод после него.
  await new Promise<void>((resolve) => setImmediate(resolve));
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

// Вердикт outbound-Gate по фразе статуса ложится в Trace с ключом хода — так же, как у ответа
// через Outbox (ADR-0010): без ключа хода событие не пишется вовсе.
test("вердикт гейта по фразе статуса — в Trace с ключом хода", async () => {
  const chat = { chatId: "817", sessionId: "s-817" };
  startTurn(chat.chatId, chat.sessionId, 505);
  const key = `sk-ant-api03-${"Qw7_".repeat(12)}`;
  const before = traceEvents().length;

  await emit("message.completed", step("tool-calls", `Беру ${key}`), chat);

  const gates = traceEvents()
    .slice(before)
    .filter((event) => event.kind === "gate" && event.name === "outbound");
  assert.equal(gates.length, 1, JSON.stringify(gates));
  assert.equal(gates[0].turn, "turn_1");
  assert.equal(gates[0].session, "s-817");
  assert.equal(gates[0].source, "telegram");
  const data = gates[0].data as { clean: boolean; findings: string[] };
  assert.equal(data.clean, false);
  assert.ok(data.findings.length > 0);
  assert.equal(JSON.stringify(gates[0]).includes(key.slice(0, 16)), false);
});

// Лимиты Telegram: в личном чате около сообщения в секунду, в группе — 20 сообщений в минуту.
// Правка статуса, по худшему счёту, идёт в тот же лимит, что и ответ, а Outbox на 429 не
// ждёт retry_after: кусок ответа, упёршийся в лимит, теряется. Правки обязаны оставлять ответу
// место в лимите группы.
test("правки статуса не отнимают у ответа лимит группы: ответ доходит", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.UTC(2026, 9, 10, 9),
  });
  const chat = {
    chatId: "-100818",
    sessionId: "s-818",
    chatType: "supergroup",
  };
  startTurn(chat.chatId, chat.sessionId, 506);
  const sentAt = [Date.now()]; // статус хода уже в чате
  const delivered: string[] = [];
  telegramReply = ({ method, body }) => {
    if (!["sendMessage", "sendRichMessage", "editMessageText"].includes(method))
      return null;
    const now = Date.now();
    if (sentAt.filter((at) => now - at < 60_000).length >= 20)
      return Response.json(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 9",
          parameters: { retry_after: 9 },
        },
        { status: 429 },
      );
    sentAt.push(now);
    if (method === "sendMessage") delivered.push(String(body?.text));
    return null;
  };
  try {
    // Две минуты модель пишет по ходу работы каждую секунду: чаще правок, так что их
    // частоту задаёт только STATUS_EDIT_INTERVAL_MS.
    for (let second = 0; second < 120; second++) {
      await emit(
        "message.completed",
        step("tool-calls", `Читаю файл ${second}.`),
        chat,
      );
      t.mock.timers.tick(1_000);
    }
    await emit("message.completed", step("stop", "Нашла два письма."), chat);
  } finally {
    telegramReply = () => null;
  }

  assert.deepEqual(delivered, ["Нашла два письма."]);
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

// Мост берёт из статуса только stoppedText и TELEGRAM_STOP_CALLBACK, и берёт их из модуля без
// гейта: сломанный модуль гейта (половина обновления) не должен мешать мосту подняться. Модуль
// статуса грузит гейт вместе с собой, поэтому без гейта он не грузится вовсе, и фраза модели
// мимо гейта в чат не идёт. Отдельный процесс: в этом гейт уже загружен.
test("сломанный модуль гейта не мешает мосту стартовать, а статус без гейта не грузится", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const childData = mkdtempSync(join(tmpdir(), "iva-status-progress-bridge-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
registerHooks({
  load: (url, context, next) =>
    url.includes("/agent/lib/security-gate.ts")
      ? { format: "module", source: "throw new Error('gate module broken')", shortCircuit: true }
      : next(url, context),
});
const at = (path) => import(pathToFileURL(join(process.env.IVA_ROOT, path)).href);
const control = await at("scripts/poller/control.ts");
const stop = await at("agent/lib/telegram-status-stop.ts");
const status = await at("agent/lib/telegram-status-message.ts").then(
  () => ({ loaded: true }),
  (error) => ({ loaded: false, reason: String(error?.message ?? error) }),
);
console.log(JSON.stringify({ bridge: typeof control.handleControl, stop: stop.TELEGRAM_STOP_CALLBACK, status }));
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          IVA_ROOT: root,
          ASSISTANT_DATA_DIR: childData,
          AGENT_LANGUAGE: "en",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const seen = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as {
      bridge: string;
      stop: string;
      status: { loaded: boolean; reason?: string };
    };
    assert.equal(seen.bridge, "function");
    assert.equal(seen.stop, "iva_cancel");
    assert.equal(seen.status.loaded, false);
    // Статус не загрузился именно из-за гейта, а не по другой причине.
    assert.match(seen.status.reason ?? "", /security-gate/u);
  } finally {
    rmSync(childData, { recursive: true, force: true });
  }
});
