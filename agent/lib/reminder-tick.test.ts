/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Контракт минутного тика: что забрано, что закрыто дочерним процессом, что тик пометил
// сам, и что осталось в аренде. Путь к данным считается на каждом вызове, поэтому
// ASSISTANT_DATA_DIR меняется до импорта модулей (образец reminder-store.test.ts).
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type {
  RunScheduledJobOptions,
  RunScheduledJobResult,
} from "./schedule-runner.ts";

const root = mkdtempSync(join(tmpdir(), "iva-reminder-tick-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { REMINDER_LEASE_MS, add, complete, list, reminderFile } =
  await import("./reminder-store.ts");
const {
  ReminderTickError,
  readTickHeartbeat,
  runReminderTick,
  tickHeartbeatFile,
} = await import("./reminder-tick.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** Просроченная строка с точным сроком; поля по умолчанию не нужны ни одному сценарию. */
const at = (id: string, atMs: number) =>
  add({
    id,
    text: `напоминание ${id}`,
    mode: "verbatim",
    schedule: { kind: "at", atMs },
    deliver: { chatId: "555" },
  });

const ok = (id: string, nowMs: number) =>
  complete(id, { nowMs, status: "ok", deliveredKey: `key-${id}` }).then(
    (): RunScheduledJobResult => ({
      skipped: false,
      ok: true,
      code: 0,
      signal: null,
    }),
  );

/** Двойник runScheduledJob: помнит вызовы и отвечает по сценарию теста. */
function jobStub(
  handler: (
    id: string,
  ) => RunScheduledJobResult | Promise<RunScheduledJobResult>,
) {
  const calls: RunScheduledJobOptions[] = [];
  const runJob = (
    options: RunScheduledJobOptions,
  ): Promise<RunScheduledJobResult> => {
    calls.push(options);
    return Promise.resolve(handler(String(options.argv[1])));
  };
  return { calls, runJob };
}

function logLines() {
  const lines: string[] = [];
  const log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  return { lines, log };
}

void test("два просроченных напоминания уходят по одному разу, отметка тика записана", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  await at("b", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub((id) => ok(id, now));

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 2, settledByChild: 2, failedByTick: 0 });
  assert.deepEqual(
    stub.calls.map((call) => [...call.argv]),
    [
      ["scripts/reminders/deliver.ts", "a"],
      ["scripts/reminders/deliver.ts", "b"],
    ],
  );
  for (const call of stub.calls) {
    assert.equal(call.timeoutMs, REMINDER_LEASE_MS - 60_000);
    // Без statusPath двухчасовой гвард расписаний не задействован, а лок не нужен:
    // строки уже разведены арендой таблицы.
    assert.equal(call.statusPath, undefined);
    assert.equal(call.lockPath, undefined);
  }
  assert.deepEqual(await list(), []);
  assert.deepEqual(readTickHeartbeat(), { lastTickAtMs: now, claimed: 2 });
  assert.equal(statSync(tickHeartbeatFile()).mode & 0o777, 0o600);
  assert.ok(
    lines.some((line) => line.includes("reminders: tick claimed 2: a, b")),
  );

  const second = jobStub((id) => ok(id, now + 60_000));
  const again = await runReminderTick({
    nowMs: now + 60_000,
    runJob: second.runJob,
    log,
  });
  assert.deepEqual(again, { claimed: 0, settledByChild: 0, failedByTick: 0 });
  assert.equal(second.calls.length, 0);

  // Предел строк за тик: три просроченных, limit 1 — берётся только ближайшая.
  await at("c", now - 30_000);
  await at("d", now - 30_000);
  await at("e", now - 30_000);
  const limited = jobStub((id) => ok(id, now));
  const one = await runReminderTick({
    nowMs: now,
    limit: 1,
    runJob: limited.runJob,
    log,
  });
  assert.deepEqual(one, { claimed: 1, settledByChild: 1, failedByTick: 0 });
  assert.deepEqual(
    limited.calls.map((call) => [...call.argv]),
    [["scripts/reminders/deliver.ts", "c"]],
  );
  assert.deepEqual(
    (await list()).map((row) => row.id),
    ["d", "e"],
  );
});

void test("после суток простоя просроченное уходит, будущее ждёт", async () => {
  const now = Date.now();
  await at("a", now - 86_400_000);
  const waiting = await at("b", now + 3_600_000);
  const stub = jobStub((id) => ok(id, now));

  await runReminderTick({ nowMs: now, runJob: stub.runJob, log: () => {} });

  assert.deepEqual(
    stub.calls.map((call) => call.argv[1]),
    ["a"],
  );
  const rows = await list();
  assert.deepEqual(
    rows.map((row) => row.id),
    ["b"],
  );
  assert.equal(rows[0]?.leaseUntilMs, null);
  assert.equal(rows[0]?.lastStatus, null);
  assert.equal(rows[0]?.nextRunAtMs, waiting.nextRunAtMs);
});

void test("провал одной строки не мешает другой, незакрытая строка помечается", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  await at("b", now - 60_000);
  await at("c", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub((id) => {
    if (id === "a") return Promise.reject(new Error("spawn boom"));
    if (id === "b") return ok(id, now);
    return { skipped: false, ok: false, code: 1, signal: null };
  });

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 3, settledByChild: 1, failedByTick: 2 });
  const rows = await list();
  const first = rows.find((row) => row.id === "a");
  assert.ok(first);
  // Сломанный шов тик не угадывает: строку никто не закрыл, аренда истечёт сама.
  assert.equal(first.leaseUntilMs, now + REMINDER_LEASE_MS);
  assert.equal(first.lastStatus, null);
  assert.ok(!rows.some((row) => row.id === "b"));
  const third = rows.find((row) => row.id === "c");
  assert.ok(third);
  assert.equal(third.lastStatus, "failed");
  assert.match(String(third.lastError), /^delivery process exited 1/);
  assert.equal(third.leaseUntilMs, null);
  assert.ok(lines.some((line) => line.includes("tick handler threw")));
  assert.ok(lines.some((line) => line.includes("reminders: c failed:")));
});

void test("недоступная таблица не роняет тик и не пишет отметку", async () => {
  writeFileSync(reminderFile(), "{broken");
  const { lines, log } = logLines();
  const stub = jobStub((id) => ok(id, Date.now()));

  const result = await runReminderTick({
    nowMs: Date.now(),
    runJob: stub.runJob,
    log,
  });

  assert.match(String(result.error), /damaged/);
  assert.equal(result.claimed, 0);
  assert.equal(stub.calls.length, 0);
  assert.equal(readTickHeartbeat(), null);
  assert.ok(lines.some((line) => line.includes("reminders: tick failed:")));

  writeFileSync(tickHeartbeatFile(), "nope");
  assert.throws(
    () => readTickHeartbeat(),
    (error: unknown) =>
      error instanceof ReminderTickError &&
      error.message.includes(tickHeartbeatFile()),
  );
});

void test("гонка: строка закрыта дочерним процессом после проверки", async () => {
  const now = Date.now();
  await at("a", now - 60_000);
  const { lines, log } = logLines();
  const stub = jobStub(async (id) => {
    await complete(id, { nowMs: now, status: "ok", deliveredKey: "key" });
    return { skipped: false, ok: false, code: 1, signal: null };
  });

  const result = await runReminderTick({
    nowMs: now,
    runJob: stub.runJob,
    log,
  });

  assert.deepEqual(result, { claimed: 1, settledByChild: 1, failedByTick: 0 });
  assert.deepEqual(await list(), []);
  assert.ok(!lines.some((line) => line.includes("failed:")));
});
