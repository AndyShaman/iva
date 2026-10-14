import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Статус живёт в run-status, а язык — в settings: оба читают ASSISTANT_DATA_DIR
// на загрузке модуля, поэтому окружение выставляем до импорта.
const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.AGENT_LANGUAGE = "en";
const load = <T>(name: string): Promise<T> =>
  import(
    pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href
  ) as Promise<T>;
const status = await load<typeof import("./telegram-draft.ts")>(
  "./telegram-draft.ts",
);
const runStatus =
  await load<typeof import("./run-status.ts")>("./run-status.ts");

type Call = { method: string; body: Record<string, unknown> };

function handle(
  reply: (
    call: Call,
    index: number,
  ) => { ok: boolean; body: unknown } = () => ({
    ok: true,
    body: { result: { message_id: 500 } },
  }),
) {
  const calls: Call[] = [];
  return {
    calls,
    tg: {
      chatId: "77",
      request: (method: string, body?: Record<string, unknown>) => {
        const call = { method, body: body ?? {} };
        calls.push(call);
        return Promise.resolve(reply(call, calls.length - 1));
      },
    },
  };
}

await test("обычный финал гасит статус и убирает сообщение, повтор — no-op", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-1",
    draftId: 500,
  });
  const { calls, tg } = handle();
  const channel = { telegram: tg };

  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");

  // Позднее терминальное событие того же хода не должно трогать чужой статус.
  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    false,
  );
  assert.equal(calls.length, 0);
});

await test("отмена переписывает статус и оставляет пометку прерванного хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-2",
    draftId: 501,
  });
  const { tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-2", "cancelled"),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.wasCancelled, true);
});

await test("сбой Bot API на уборке не рушит терминал хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-3",
    draftId: 502,
  });
  const failing = {
    chatId: "77",
    request: () => Promise.reject(new Error("Telegram 502")),
  };

  assert.equal(
    await status.finishTelegramStatus({ telegram: failing }, "s-3", "failed"),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("чужая живая сессия не трогается поздним финишем", async () => {
  // Regression anchor from code review: a late terminal must not delete another
  // session's status message. Not a full discriminator of the current impl.
  const key = runStatus.chatKeyOf("77", undefined);
  // Живая чужая сессия — поздний terminal от старой сессии должен быть no-op.
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-live",
    draftId: 777,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus(
      { telegram: tg },
      "s-old-finished",
      "completed",
    ),
    false,
  );
  assert.equal(calls.length, 0);
  const live = runStatus.getChatStatus(key);
  assert.equal(live?.status, "running");
  assert.equal(live?.sessionId, "s-live");
  assert.equal(live?.draftId, 777);
});

await test("своя сессия гасит статус-сообщение", async () => {
  // Regression anchor from code review: a late terminal must not delete another
  // session's status message. Not a full discriminator of the current impl.
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-own",
    draftId: 801,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-own", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("знак очереди переживает любой финал хода: его заберёт следующий ход", async () => {
  // eve хранит буфер входа и после отмены (steer отменяет ход ради нового сообщения), и
  // после сбоя хода: сообщение со знаком начнёт следующий ход. Знак мигать не должен.
  const key = runStatus.chatKeyOf("77", undefined);
  const queued = {
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 1_000,

    queuedSessionId: "s-q",
  };
  for (const mode of ["completed", "cancelled", "failed"] as const) {
    runStatus.setChatStatus(key, {
      status: "running",
      sessionId: "s-q",
      draftId: 900,
      ...queued,
    });
    const { calls, tg } = handle();
    assert.equal(
      await status.finishTelegramStatus({ telegram: tg }, "s-q", mode),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.body.message_id),
      [],
      mode,
    );
    const after = runStatus.getChatStatus(key);
    for (const [field, value] of Object.entries(queued))
      assert.equal(after?.[field], value, `${mode}: ${field}`);
  }
  runStatus.setChatStatus(key, {
    queuedIngressId: null,
    queuedIngressAt: null,
    queuedSessionId: null,
  });
});

process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

await test("принятое сообщение видит typing в течение 20 секунд до turn.started; CAS передаёт поток ходу", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 100_000,
  });
  t.after(() => t.mock.timers.reset());
  const { publishTelegramEarlyStatus, publishTelegramTurnStarted } =
    await import("./telegram-turn-start.ts");
  const { startTelegramAcceptedTyping, telegramDraftTurn } = status;
  const { calls, tg } = handle();
  const key = runStatus.chatKeyOf(tg.chatId);
  runStatus.setChatStatus(key, {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  const ingressId = await publishTelegramEarlyStatus({
    chatKey: key,
    ingressId: "accepted-20s",
    getStatusImpl: runStatus.getChatStatus,
    setStatusIfImpl: runStatus.setChatStatusIf,
  });
  assert.equal(ingressId, "accepted-20s");
  startTelegramAcceptedTyping(tg, ingressId!);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(4500);
    await flush();
  }
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.method === "sendChatAction"));
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: key,
      sessionId: "accepted-session",
      turnId: "accepted-turn",
      draftId: 21,
      getStatusImpl: runStatus.getChatStatus,
      setStatusIfImpl: runStatus.setChatStatusIf,
    }),
    true,
  );
  telegramDraftTurn(tg, "accepted-session", "accepted-turn", true, {
    sessionId: "accepted-session",
    turnId: "accepted-turn",
    draftId: 21,
  });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(
    calls.filter((c) => c.method === "sendRichMessageDraft").length,
    1,
  );
  await status.finishTelegramStatus(
    { telegram: tg },
    "accepted-session",
    "completed",
    "accepted-turn",
  );
  const count = calls.length;
  t.mock.timers.tick(40_000);
  await flush();
  assert.equal(calls.length, count);
});
