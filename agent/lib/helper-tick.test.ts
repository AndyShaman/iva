/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelperTick } from "./helper-tick.ts";
import * as s from "./helper-store.ts";
import { OWNER_STARTED_AT } from "./schedule-runner.ts";
const chat = { id: "42", threadId: null };
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-tick-"));
  const prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function row() {
  const r = await s.addHelper({ task: "task", may: "", chat }, 1000);
  assert.ok(r.ok);
  return r.row;
}
test("T9 accepted holds slot; dead/restarted owner cannot kill a persisted foreign pid", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerPid: 123, ownerStartedAt: 1 }, 2000);
  await s.recordHelperChild(a.id, 2000, 222);
  await s.recordHelperSession(a.id, 2000, "server");
  const killed: number[] = [];
  const deps = {
    nowMs: 3000,
    bootAt: 10,
    ownerDead: () => true,
    alive: () => false,
    kill: (pid: number) => {
      killed.push(pid);
    },
    cancel: () =>
      Promise.resolve({ status: "accepted" as const, sessionId: "server" }),
  };
  await runHelperTick(deps);
  assert.ok((await s.getHelper(a.id))?.run);
  assert.deepEqual(killed, []);
  await runHelperTick({
    ...deps,
    cancel: () => Promise.resolve({ status: "no_active_turn" as const }),
  });
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
});
test("startFailed and concurrent ticks claim one row only once", async (t) => {
  await setup(t);
  const b = await row();
  let starts = 0;
  const deps = {
    nowMs: 9000,
    start: () => {
      starts++;
      return Promise.resolve({
        startFailed: true as const,
        error: Error("spawn failed"),
      });
    },
  };
  await Promise.all([runHelperTick(deps), runHelperTick(deps)]);
  assert.equal(starts, 1);
  assert.equal((await s.getHelper(b.id))?.outcome, "failed");
});
test("closed living owner leaves its client to cancel and preserve partial text", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(
    a.id,
    { ownerPid: process.pid, ownerStartedAt: OWNER_STARTED_AT },
    2000,
  );
  await s.recordHelperChild(a.id, 2000, 222);
  await s.recordHelperSession(a.id, 2000, "server");
  await s.closeHelper(a.id, chat, 2100);
  const killed: number[] = [];
  let cancels = 0;
  await runHelperTick({
    nowMs: 2200,
    bootAt: 0,
    ownerDead: () => false,
    alive: () => true,
    kill: (pid) => {
      killed.push(pid);
    },
    cancel: () => {
      cancels++;
      return Promise.resolve({
        status: "accepted" as const,
        sessionId: "server",
      });
    },
  });
  assert.equal(killed.length, 0);
  assert.equal(cancels, 0);
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({
    nowMs: 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
    bootAt: 0,
    ownerDead: () => false,
    alive: () => true,
    kill: (pid) => {
      killed.push(pid);
    },
    cancel: () => Promise.resolve({ status: "no_active_turn" as const }),
  });
  assert.deepEqual(killed, [-222]);
  assert.equal((await s.getHelper(a.id))?.outcome, "stopped");
});
test("corrupt table logs/Trace and exits without cleanup or child start", async (t) => {
  const dir = await setup(t);
  await writeFile(join(dir, "helpers.json"), "{");
  let spawned = false;
  await runHelperTick({
    log: () => {},
    start: () => {
      spawned = true;
      return Promise.resolve({ startFailed: true as const, error: Error() });
    },
  });
  assert.equal(spawned, false);
  assert.ok((await readdir(dir)).includes("helpers.json"));
});
test("T9 precedes admission; one unfinished child holds the only slot", async (t) => {
  await setup(t);
  const pending = await row(),
    old = await row();
  await s.claimHelper(old.id, { ownerPid: 123, ownerStartedAt: 1 }, 2000);
  await s.recordHelperSession(old.id, 2000, "server");
  const calls: string[] = [];
  await runHelperTick({
    nowMs: 3000,
    ownerDead: () => true,
    cancel: () => {
      calls.push("cancel");
      return Promise.resolve({ status: "no_active_turn" as const });
    },
    start: () => {
      calls.push("start");
      return Promise.resolve({
        startFailed: false as const,
        pid: 100000,
        completion: new Promise(() => {}),
      });
    },
  });
  assert.equal((await s.getHelper(old.id))?.outcome, "interrupted");
  assert.ok((await s.getHelper(pending.id))?.run);
  assert.deepEqual(calls, ["cancel", "start"]);
  await row();
  await runHelperTick({
    nowMs: 3000,
    bootAt: 0,
    alive: () => true,
    ownerDead: () => false,
    start: () => {
      assert.fail("capacity is one");
    },
  });
  assert.equal((await s.readHelpers()).rows.filter((r) => r.run).length, 1);
});
test("child spawn preceding a failed durable pid write still registers completion recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  await setup(t);
  const fsp = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const rename = fsp.rename.bind(fsp);
  const originalReaddir = fsp.readdir.bind(fsp);
  let recovered = false;
  t.mock.method(
    fsp,
    "readdir",
    async (...args: Parameters<typeof fsp.readdir>) => {
      const entries = await originalReaddir(...args);
      if ((await s.getHelper(a.id))?.outcome === "interrupted")
        recovered = true;
      return entries;
    },
  );
  let fail = false;
  t.mock.method(fsp, "rename", (from: string, to: string) => {
    if (fail && to.endsWith("/helpers.json")) {
      fail = false;
      return Promise.reject(Error("pid write failed"));
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const a = await row();
  let finish: (value: { skipped: false; ok: false }) => void = () => {};
  const completion = new Promise<{ skipped: false; ok: false }>((resolve) => {
    finish = resolve;
  });
  await runHelperTick({
    start: () => {
      fail = true;
      return Promise.resolve({
        startFailed: false as const,
        pid: 100000,
        completion,
      });
    },
    log: () => {},
  });
  assert.equal((await s.getHelper(a.id))?.run?.childPid, null);
  assert.ok((await s.getHelper(a.id))?.run);
  finish({ skipped: false, ok: false });
  for (let i = 0; i < 100 && !recovered; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
});
