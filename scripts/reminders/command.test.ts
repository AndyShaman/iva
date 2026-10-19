/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import "../lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, runCommandFire } from "./command.ts";
import {
  add,
  list,
  fireDue,
  commandFile,
  commandLog,
  reschedule,
} from "../../agent/lib/reminder-store.ts";
import { runReminderTick } from "../../agent/lib/reminder-tick.ts";
const dir = mkdtempSync(join(tmpdir(), "iva-command-test-"));
process.env.ASSISTANT_DATA_DIR = dir;
process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
process.env.SCHEDULE_TEST_ENV = "inherited";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
async function row(command: string) {
  await add(
    { id: "c-test", text: command, schedule: { kind: "at", atMs: 1 } },
    { file: commandFile() },
  );
  return (await fireDue(2, 5, commandFile()))[0];
}
test("command success stays quiet, inherits bash environment/cwd, and caps its journal", async () => {
  await row(
    'printf "%s %s\\n" "$PWD" "$SCHEDULE_TEST_ENV"; printf "%040000d" 0',
  );
  let sends = 0;
  await runCommandFire("c-test", {
    root: dir,
    send: () => {
      sends++;
      return Promise.reject(new Error("success must be quiet"));
    },
  });
  const result = (await list(commandFile()))[0];
  assert.equal(result.delivered, true);
  assert.equal(result.error, null);
  assert.equal(sends, 0);
  assert.ok(readFileSync(commandLog("c-test"), "utf8").length <= 32000);
  const env = await runCommand(
    'printf "%s %s" "$PWD" "$SCHEDULE_TEST_ENV"',
    dir,
  );
  assert.equal(env.output, `${realpathSync(dir)} inherited`);
});
test("command error alerts once, preserves error fact and journal, repeated failure is throttled", async () => {
  await row("echo broken; exit 7");
  const messages: string[] = [];
  const send = (_token: string, _chat: string, text: unknown) => {
    messages.push(String(text));
    return Promise.resolve({ ok: true, fellBack: false, error: "" });
  };
  await runCommandFire("c-test", { root: dir, send });
  assert.deepEqual(messages, [
    "Задача «echo broken; exit 7» не выполнилась: завершилась с ошибкой. Журнал: list",
  ]);
  assert.equal((await list(commandFile()))[0]?.error, "exit 7");
  assert.match(readFileSync(commandLog("c-test"), "utf8"), /broken/);
  await reschedule("c-test", { nowMs: 3 }, commandFile());
  await fireDue(3, 5, commandFile());
  await runCommandFire("c-test", { root: dir, send });
  assert.equal(messages.length, 1);
});
test("timeout kills the shell and its descendant process group and alerts once", async () => {
  const pidFile = join(dir, "child.pid");
  // The descendant ignores TERM; a shell-only timeout would leave it alive.
  await row(
    `bash -c 'trap "" TERM; while :; do sleep 1; done' & echo $! > '${pidFile}'; wait`,
  );
  const messages: string[] = [];
  await runCommandFire("c-test", {
    root: dir,
    timeoutMs: 250,
    send: (_token, _chat, text) => {
      messages.push(String(text));
      return Promise.resolve({ ok: true, fellBack: false, error: "" });
    },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /не уложилась в 2 минуты/);
  const pid = readFileSync(pidFile, "utf8").trim();
  let state = "";
  try {
    state = execFileSync("/bin/ps", ["-o", "stat=", "-p", pid], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    assert.equal((error as { status: number }).status, 1);
  }
  assert.ok(
    state === "" || state.startsWith("Z"),
    `descendant ${pid} still live: ${state}`,
  );
  assert.match((await list(commandFile()))[0]?.error ?? "", /timeout/);
});
test("the shared dispatcher runs command rows through its command child once", async () => {
  await add(
    { id: "c-test", text: "printf done", schedule: { kind: "at", atMs: 1 } },
    { file: commandFile() },
  );
  let starts = 0;
  const tick = async () =>
    runReminderTick({
      command: true,
      nowMs: 2,
      root: dir,
      runJob: async (options) => {
        starts++;
        assert.deepEqual(options.argv, [
          "scripts/reminders/command.ts",
          "c-test",
          "2",
        ]);
        await runCommandFire("c-test", { root: dir });
        return { ok: true, skipped: false, code: 0, signal: null };
      },
      log: () => {},
    });
  await Promise.all([tick(), tick()]);
  assert.equal(starts, 1);
  assert.equal((await list(commandFile()))[0]?.delivered, true);
});
test("real minute dispatcher child records a command result without a model", async () => {
  process.env.TELEGRAM_ALLOWED_USER_IDS = "";
  const firing = Date.now();
  try {
    await add(
      {
        id: "c-child",
        text: "printf child-executed",
        schedule: { kind: "at", atMs: firing },
      },
      { file: commandFile() },
    );
    const result = await runReminderTick({
      command: true,
      nowMs: firing,
      log: () => {},
    });
    assert.equal(result.spawned, 1);
    assert.equal(result.filled, 0);
    assert.equal((await list(commandFile()))[0]?.delivered, true);
    assert.match(readFileSync(commandLog("c-child"), "utf8"), /child-executed/);
  } finally {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  }
});

test("a delayed child cannot execute a later firing of the same row", async () => {
  await row("printf current");
  assert.equal(await runCommandFire("c-test", { root: dir, firedAt: 1 }), 2);
  assert.equal((await list(commandFile()))[0]?.delivered, null);
});
