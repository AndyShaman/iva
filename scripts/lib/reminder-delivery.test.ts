/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Доставка арендованной строки: исполнение (ход) и отправка живут раздельно, повтор того же
// срока не шлётся дважды, провалы троттлятся и ограничены окном, а после второго провала
// подряд владелец получает один Alert. Путь к данным считается на каждом вызове, поэтому
// ASSISTANT_DATA_DIR меняется до импорта таблицы (образец reminder-store.test.ts).
// `send` и ход здесь фейки, Alert — настоящий: его состояние лежит в alert-state.json
// временного каталога.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, beforeEach } from "node:test";
import { nextCronRunMs } from "#lib/reminder-time.ts";
import type { Reminder } from "#lib/reminder-store.ts";
import {
  deliveredKeyOf,
  settleReminder,
  type SettleDeps,
} from "./reminder-delivery.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "iva-reminder-delivery-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const store = await import("#lib/reminder-store.ts");
const { saveJsonAtomic } = await import("#lib/json-store.ts");
const { alertOnce, alertResolved } = await import("./notice-policy.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
  mkdirSync(caseDir, { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

type SendOptions = {
  readonly retryTransient?: boolean;
  readonly trace?: { readonly source?: string };
};
type SendCall = {
  readonly bot: string;
  readonly chat: string;
  readonly text: unknown;
  readonly options: SendOptions | undefined;
};

/** Отправка-шпион: записывает вызовы и отвечает по сценарию теста. */
function makeSend(
  answer: (call: SendCall) => { ok: boolean; fellBack: boolean; error: string },
) {
  const calls: SendCall[] = [];
  const send = (
    bot: string,
    chat: string,
    text: unknown,
    options?: SendOptions,
  ) => {
    const call = { bot, chat, text, options };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { send, calls };
}

const alertCallsOf = (calls: readonly SendCall[]) =>
  calls.filter((call) => call.options?.trace?.source === "reminder-alert");

function deps(overrides: Partial<SettleDeps> = {}): SettleDeps {
  return {
    nowMs: 0,
    token: "bot-token",
    tz: "UTC",
    tr: (en: string) => en,
    send: () => Promise.resolve({ ok: true, fellBack: false, error: "" }),
    runTurn: () => Promise.reject(new Error("verbatim must not run a turn")),
    log: () => {},
    dataDir: caseDir,
    table: {
      complete: store.complete,
      remove: store.remove,
      release: store.release,
    },
    nextCronRunMs,
    alert: { alertOnce, alertResolved },
    ...overrides,
  };
}

/** Правка строки в файле: состояния, которого нет у публичного API (крэш между шагами). */
async function forceRow(
  id: string,
  patch: (row: Reminder) => Reminder,
): Promise<Reminder> {
  const rows = await store.list();
  const row = rows.find((candidate) => candidate.id === id);
  assert.ok(row, `строка ${id} есть в таблице`);
  const patched = patch(row);
  await saveJsonAtomic(
    store.reminderFile(),
    {
      schemaVersion: 1,
      rows: rows.map((candidate) =>
        candidate.id === id ? patched : candidate,
      ),
    },
    { mode: 0o600 },
  );
  return patched;
}

test("a delivered turn with a refused send leaves the row open", async () => {
  const t0 = 1_800_000_000_000;
  await store.add({
    id: "turn-then-send",
    text: "проверить задачи",
    mode: "agent",
    schedule: { kind: "at", atMs: t0 },
    deliver: { chatId: "42" },
  });
  const [claimed] = await store.claimDue(t0, 10);
  assert.ok(claimed);
  const { send, calls } = makeSend(() => ({
    ok: false,
    fellBack: false,
    error: "400 chat not found",
  }));
  const prompts: string[] = [];
  const runTurn = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve({
      status: "waiting" as const,
      message: "готово",
      feedback: () => Promise.resolve(undefined),
    });
  };

  assert.equal(
    await settleReminder(claimed, deps({ nowMs: t0, send, runTurn })),
    "failed",
    "неудавшаяся отправка — провал, а не тишина",
  );
  assert.equal(prompts.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].text,
    "готово",
    "провал отправки не подменяет текст хода",
  );
  assert.equal(calls[0].chat, "42");

  const rows = await store.list();
  assert.equal(
    rows.length,
    1,
    "разовая строка не удалена, пока сообщение не ушло",
  );
  assert.equal(rows[0].lastStatus, "failed");
  assert.match(
    rows[0].lastError ?? "",
    /^send: 400 chat not found \(turn ok\)$/u,
  );
  assert.equal(
    rows[0].leaseUntilMs,
    null,
    "аренда снята: строка повторится по троттлингу",
  );
});

test("the same deliveredKey is not sent twice", async () => {
  const t0 = 1_800_000_000_000;
  const nextRunAtMs = t0 - 60_000;
  await store.add({
    id: "cron-dup",
    text: "вода",
    mode: "verbatim",
    schedule: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" },
    nextRunAtMs,
    deliver: { chatId: "42" },
  });
  const [first] = await store.claimDue(t0, 10);
  assert.ok(first);
  const key = deliveredKeyOf(first);
  assert.equal(key, `cron-dup:${nextRunAtMs}`);
  // Крэш между отправкой и complete: ключ уже записан, аренда отпущена.
  await forceRow("cron-dup", (row) => ({
    ...row,
    deliveredKey: key,
    leaseUntilMs: null,
  }));

  const [second] = await store.claimDue(t0, 10);
  assert.ok(second);
  const { send, calls } = makeSend(() => ({
    ok: true,
    fellBack: false,
    error: "",
  }));
  const settlement = await settleReminder(second, deps({ nowMs: t0, send }));
  assert.equal(
    calls.length,
    0,
    "тот же срок уже доставлен — повторной отправки нет",
  );
  assert.equal(settlement, "duplicate");

  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leaseUntilMs, null);
  assert.equal(rows[0].nextRunAtMs, nextCronRunMs("*/15 * * * *", "UTC", t0));
  assert.ok(rows[0].nextRunAtMs > t0);
});

test("the owner gets one Alert after two failures in a row, throttled for an hour", async () => {
  const t0 = 1_800_000_000_000;
  const minute = 60_000;
  await store.add({
    id: "flaky-at",
    text: "выпить воды",
    mode: "verbatim",
    schedule: { kind: "at", atMs: t0 },
    deliver: { chatId: "42" },
  });
  const errors = ["403 bot blocked", "403 bot blocked", "400 timeout"];
  const { send, calls } = makeSend((call) =>
    call.options?.trace?.source === "reminder-alert"
      ? { ok: true, fellBack: false, error: "" }
      : {
          ok: false,
          fellBack: false,
          error: errors.shift() ?? "403 bot blocked",
        },
  );

  const [atT0] = await store.claimDue(t0, 10);
  assert.ok(atT0);
  assert.equal(await settleReminder(atT0, deps({ nowMs: t0, send })), "failed");
  assert.equal(alertCallsOf(calls).length, 0, "первый провал — ещё без Alert");

  const [atT6] = await store.claimDue(t0 + 6 * minute, 10);
  assert.ok(atT6);
  assert.equal(atT6.lastStatus, "failed", "второй провал подряд");
  assert.equal(
    await settleReminder(atT6, deps({ nowMs: t0 + 6 * minute, send })),
    "failed",
  );
  assert.equal(alertCallsOf(calls).length, 1, "второй провал — один Alert");
  const alertText = String(alertCallsOf(calls)[0].text);
  assert.match(alertText, /403 bot blocked/u, "Alert называет причину");
  assert.match(
    alertText,
    /remind_remove flaky-at/u,
    "Alert говорит, что делать",
  );
  assert.match(
    alertText,
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u,
    "Alert называет срок повторов",
  );

  const [atT12] = await store.claimDue(t0 + 12 * minute, 10);
  assert.ok(atT12);
  assert.equal(
    await settleReminder(atT12, deps({ nowMs: t0 + 12 * minute, send })),
    "failed",
  );
  assert.equal(
    alertCallsOf(calls).length,
    1,
    "третий провал внутри часа молчит",
  );

  const state = JSON.parse(
    readFileSync(join(caseDir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state), ["reminder-flaky-at"]);

  const { send: sendOk, calls: okCalls } = makeSend(() => ({
    ok: true,
    fellBack: false,
    error: "",
  }));
  const [atT18] = await store.claimDue(t0 + 18 * minute, 10);
  assert.ok(atT18);
  assert.equal(
    await settleReminder(
      atT18,
      deps({ nowMs: t0 + 18 * minute, send: sendOk }),
    ),
    "delivered",
  );
  assert.equal(okCalls.length, 1);
  assert.deepEqual(await store.list(), [], "успех снимает разовую строку");
  const resolved = JSON.parse(
    readFileSync(join(caseDir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(resolved), [], "успех забывает Alert");
});

test("retries are throttled to five minutes and dropped after the window", async () => {
  const now = 1_800_000_000_000;
  const minute = 60_000;

  await store.add({
    id: "retry-now",
    text: "раз",
    mode: "verbatim",
    schedule: { kind: "at", atMs: now - minute },
    deliver: { chatId: "42" },
  });
  await forceRow("retry-now", (row) => ({
    ...row,
    lastStatus: "failed",
    lastError: "boom",
    lastRunAtMs: now - minute,
  }));
  const [soon] = await store.claimDue(now, 10);
  assert.ok(soon);
  const { send, calls } = makeSend(() => ({
    ok: true,
    fellBack: false,
    error: "",
  }));
  assert.equal(
    await settleReminder(soon, deps({ nowMs: now, send })),
    "deferred",
  );
  assert.equal(calls.length, 0, "повтор раньше пяти минут не отправляется");
  assert.equal(
    (await store.list())[0].leaseUntilMs,
    null,
    "строка отпущена следующему тику",
  );

  await store.add({
    id: "at-expired",
    text: "полный текст снятого напоминания",
    mode: "verbatim",
    schedule: { kind: "at", atMs: now - 7 * 60 * minute },
    deliver: { chatId: "42" },
  });
  await forceRow("at-expired", (row) => ({
    ...row,
    lastStatus: "failed",
    lastError: "boom",
    lastRunAtMs: now - 10 * minute,
  }));
  const [expired] = await store.claimDue(now, 10);
  assert.ok(expired);
  assert.equal(
    await settleReminder(expired, deps({ nowMs: now, send })),
    "dropped",
  );
  assert.deepEqual(
    (await store.list()).map((row) => row.id),
    ["retry-now"],
    "шесть часов провалов снимают разовую строку, соседняя строка не тронута",
  );
  const droppedAlerts = alertCallsOf(calls);
  assert.equal(droppedAlerts.length, 1, "снятие говорит владельцу один раз");
  assert.match(
    String(droppedAlerts[0].text),
    /полный текст снятого напоминания/u,
  );
  assert.match(String(droppedAlerts[0].text), /boom/u);

  await store.add({
    id: "cron-expired",
    text: "повторяющееся",
    mode: "verbatim",
    schedule: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" },
    nextRunAtMs: now - 40 * minute,
    deliver: { chatId: "42" },
  });
  await forceRow("cron-expired", (row) => ({
    ...row,
    lastStatus: "failed",
    lastError: "boom",
    lastRunAtMs: now - 10 * minute,
  }));
  const [cronExpired] = await store.claimDue(now, 10);
  assert.ok(cronExpired);
  assert.equal(
    await settleReminder(cronExpired, deps({ nowMs: now, send })),
    "skipped-occurrence",
  );
  const rows = await store.list();
  const skipped = rows.find((row) => row.id === "cron-expired");
  assert.ok(skipped, "пропустившая срок строка остаётся в таблице");
  assert.equal(skipped.lastStatus, "failed");
  assert.match(skipped.lastError ?? "", /gave up on this occurrence/u);
  assert.equal(
    skipped.nextRunAtMs,
    nextCronRunMs("*/15 * * * *", "UTC", now),
    "следующий срок считается от now, а не от пропущенного",
  );
  assert.ok(
    skipped.nextRunAtMs > now,
    "пропущенный срок не остаётся в прошлом",
  );
  const cronAlerts = alertCallsOf(calls);
  assert.equal(cronAlerts.length, 2, "пропущенный срок — второй Alert");
  assert.match(String(cronAlerts[1].text), /Next run:/u);
});

test("the delivery entry refuses to run outside a lease", async () => {
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, ["scripts/reminders/deliver.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ASSISTANT_DATA_DIR: caseDir },
      encoding: "utf8",
    });

  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/u);

  const unknown = run(["r-nope"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown id/u);

  await store.add({
    id: "no-lease",
    text: "без аренды",
    mode: "verbatim",
    schedule: { kind: "at", atMs: Date.now() },
    deliver: { chatId: "42" },
  });
  const unleased = run(["no-lease"]);
  assert.equal(unleased.status, 2);
  assert.match(unleased.stderr, /not leased/u);
});
