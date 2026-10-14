/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelperTick } from "./helper-tick.ts";
import * as s from "./helper-store.ts";
import { OWNER_STARTED_AT, runScheduledJob } from "./schedule-runner.ts";
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
async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("completion did not finish");
}
test("R2 runner reports client exit once; later minute ticks repeat cancel before freeing the slot", async (t) => {
  await setup(t);
  const a = await row(),
    pending = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT }, 2000);
  await s.recordHelperSession(a.id, 2000, "server");
  let cancels = 0,
    resets = 0,
    starts = 0;
  const cancel = (id: string) => {
    assert.equal(id, "server");
    cancels++;
    return Promise.resolve({ status: "accepted" as const, sessionId: id });
  };
  const reset = () => {
    if (++resets < 3) return Promise.reject(Error("reset timed out"));
    return Promise.resolve({
      status: "reset" as const,
      previousSessionId: "server",
    });
  };
  const start: typeof runScheduledJob = () => {
    starts++;
    return new Promise(() => {});
  };
  await runHelperTick({
    nowMs: 3000,
    completed: { id: a.id, firedAt: 2000 },
    cancel,
    reset,
    log: () => {},
    start,
  });
  assert.equal(cancels, 1);
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({ nowMs: 63000, cancel, reset, log: () => {}, start });
  assert.equal(cancels, 2);
  assert.ok((await s.getHelper(a.id))?.run);
  assert.equal(starts, 0);
  await runHelperTick({ nowMs: 123000, cancel, reset, start });
  assert.equal(cancels, 3);
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
  assert.equal(starts, 1);
  assert.ok((await s.getHelper(pending.id))?.run);
});
test("F8 restart: cancel always accepted; failed reset holds slot, confirmed reset interrupts", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT - 1 }, 2000);
  await s.recordHelperSession(a.id, 2000, "server");
  await runHelperTick({
    nowMs: 3000,
    reset: () => Promise.reject(Error("reset failed")),
    log: () => {},
    cancel: (id) => {
      assert.equal(id, "server");
      return Promise.resolve({ status: "accepted", sessionId: id });
    },
  });
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({
    nowMs: 3000,
    cancel: () => Promise.resolve({ status: "accepted", sessionId: "server" }),
    reset: () => Promise.resolve({ status: "no_active_session" }),
  });
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
  assert.equal(
    await s.finalizeHelper(
      a.id,
      { kind: "running", firedAt: 2000 },
      {
        outcome: "done",
        summary: "late",
        reason: null,
        model: null,
        steps: 0,
        tokens: 0,
      },
      3001,
    ),
    null,
  );
});
test("existing runner start failure finalizes failed once, concurrent ticks claim once", async (t) => {
  await setup(t);
  const a = await row();
  let starts = 0;
  const start: typeof runScheduledJob = (o) => {
    starts++;
    assert.equal(o.timeoutMs, s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
    return Promise.resolve({
      skipped: false,
      ok: false,
      error: Error("spawn failed"),
    });
  };
  await Promise.all([
    runHelperTick({ nowMs: 9000, start }),
    runHelperTick({ nowMs: 9000, start }),
  ]);
  await waitFor(async () => (await s.getHelper(a.id))?.outcome === "failed");
  assert.equal(starts, 1);
  assert.equal((await s.getHelper(a.id))?.reason, "помощник не смог начать");
});
test("close of living client leaves cancellation/partial to the client; deadline plus grace reaps confirmed end", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT }, 2000);
  await s.recordHelperSession(a.id, 2000, "server");
  await s.closeHelper(a.id, chat, 2100);
  await runHelperTick({
    nowMs: 2200,
    cancel: () => assert.fail("stop alone must not cancel"),
  });
  assert.ok((await s.getHelper(a.id))?.run);
  const nowMs = 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS;
  await runHelperTick({
    nowMs,
    cancel: () => Promise.resolve({ status: "accepted", sessionId: "server" }),
    reset: () => Promise.reject(Error("reset timed out")),
    log: () => {},
  });
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({
    nowMs,
    cancel: () => Promise.resolve({ status: "accepted", sessionId: "server" }),
    reset: () =>
      Promise.resolve({ status: "reset", previousSessionId: "server" }),
  });
  assert.equal((await s.getHelper(a.id))?.outcome, "stopped");
});
test("deadline becomes deadline, and a same-owner unknown id holds slot until client completion", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT }, 2000);
  const nowMs = 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS;
  await runHelperTick({ nowMs });
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({ nowMs, completed: { id: a.id, firedAt: 2000 } });
  assert.equal((await s.getHelper(a.id))?.outcome, "deadline");
});
test("lost-id exception: old owner without recorded session becomes interrupted", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT - 1 }, 2000);
  await runHelperTick({ nowMs: 3000 });
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
});
test("T9 precedes admission; failed reset holds the only slot", async (t) => {
  await setup(t);
  const pending = await row(),
    old = await row();
  await s.claimHelper(old.id, { ownerStartedAt: OWNER_STARTED_AT - 1 }, 2000);
  await s.recordHelperSession(old.id, 2000, "server");
  const calls: string[] = [];
  const start: typeof runScheduledJob = () => {
    calls.push("start");
    return new Promise(() => {});
  };
  await runHelperTick({
    nowMs: 3000,
    start,
    cancel: () => Promise.resolve({ status: "accepted", sessionId: "server" }),
    reset: () => Promise.reject(Error("reset failed")),
    log: () => {},
  });
  assert.equal(calls.length, 0);
  await runHelperTick({
    nowMs: 3000,
    start,
    reset: () => {
      calls.push("reset");
      return Promise.resolve({ status: "reset", previousSessionId: "server" });
    },
    cancel: () => {
      calls.push("cancel");
      return Promise.resolve({ status: "accepted", sessionId: "server" });
    },
  });
  assert.ok((await s.getHelper(pending.id))?.run);
  assert.deepEqual(calls, ["cancel", "reset", "start"]);
  await row();
  await runHelperTick({ nowMs: 3000, start: () => assert.fail("one running") });
  assert.equal((await s.readHelpers()).rows.filter((r) => r.run).length, 1);
});
test("existing runner completion recovers lost id and emits the tick end", async (t) => {
  const dir = await setup(t);
  const a = await row();
  await runHelperTick({
    start: (o) =>
      runScheduledJob({ ...o, argv: ["-e", "process.exit(0)"], log: () => {} }),
  });
  await waitFor(
    async () => (await s.getHelper(a.id))?.outcome === "interrupted",
  );
  await waitFor(async () => {
    const files = await readdir(join(dir, "trace")).catch(() => []);
    const logs = await Promise.all(
      files.map((f) => readFile(join(dir, "trace", f), "utf8")),
    );
    return logs.join("").includes('"name":"finished"');
  });
  const logs = await Promise.all(
    (await readdir(join(dir, "trace"))).map((f) =>
      readFile(join(dir, "trace", f), "utf8"),
    ),
  );
  assert.match(logs.join(""), /"name":"finished"/);
  assert.match(logs.join(""), /"source":"helper"/);
});
test("corrupt table emits store_broken, preserves bytes and starts no child", async (t) => {
  const dir = await setup(t);
  await writeFile(join(dir, "helpers.json"), "{");
  await runHelperTick({
    log: () => {},
    start: () => assert.fail("corrupt table"),
  });
  assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), "{");
  const logs = await Promise.all(
    (await readdir(join(dir, "trace"))).map((f) =>
      readFile(join(dir, "trace", f), "utf8"),
    ),
  );
  assert.match(logs.join(""), /"name":"store_broken"/);
});

test("F8 installed client wire: accepted is followed by bounded reset; timeout retries on next tick", async (t) => {
  await setup(t);
  const a = await row();
  await s.claimHelper(a.id, { ownerStartedAt: OWNER_STARTED_AT - 1 }, 2000);
  await s.recordHelperSession(a.id, 2000, "server");
  const calls: string[] = [];
  let resets = 0;
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path.split("/").at(-1)!);
    assert.ok(init.signal instanceof AbortSignal);
    if (path.endsWith("/cancel")) {
      assert.ok(typeof init.body === "string");
      assert.deepEqual(JSON.parse(init.body), { tasks: true });
      return Promise.resolve(
        Response.json({ ok: true, status: "accepted", sessionId: "server" }),
      );
    }
    assert.ok(path.endsWith("/reset"));
    if (++resets === 1)
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    return Promise.resolve(
      Response.json({ ok: true, status: "reset", previousSessionId: "server" }),
    );
  });
  await runHelperTick({ nowMs: 3000, log: () => {} });
  assert.ok((await s.getHelper(a.id))?.run);
  await runHelperTick({ nowMs: 63000 });
  assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
  assert.deepEqual(calls, ["cancel", "reset", "cancel", "reset"]);
});
