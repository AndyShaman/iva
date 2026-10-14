/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  mkdir,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import * as s from "./helper-store.ts";
const chat = { id: "42", threadId: null };
const other = { id: "43", threadId: null };
const finish = {
  outcome: "done" as const,
  summary: "result",
  reason: null,
  model: "fixture",
  steps: 1,
  tokens: 12,
};
async function data(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-"));
  const prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function added(now = 1000) {
  const r = await s.addHelper({ task: "task", may: "", chat }, now);
  assert.ok(r.ok, r.ok ? undefined : r.text);
  return r.row;
}
async function ready(now = 1000) {
  const r = await added(now);
  await s.finalizeHelper(
    r.id,
    { kind: "pending", createdAt: now },
    finish,
    now + 1,
  );
  return r;
}
test("missing reader and schema corruption preserve bytes and reject foreign fields/types/duplicates/version", async (t) => {
  const dir = await data(t);
  assert.deepEqual(await s.readHelpers(), {
    schemaVersion: 1,
    rows: [],
    goals: [],
  });
  const row = await added();
  const base = await s.readHelpers();
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.jsonValue(), fc.constantFrom("{", "null", "[]")),
      async (value) => {
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        await writeFile(join(dir, "helpers.json"), raw);
        await assert.rejects(s.readHelpers(), s.HelperStoreError);
        assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), raw);
      },
    ),
    { seed: 20261013, numRuns: 40 },
  );
  for (const value of [
    { ...base, x: 1 },
    { ...base, schemaVersion: 2 },
    { ...base, rows: [row, row] },
    { ...base, rows: [{ ...row, x: 1 }] },
    { ...base, rows: [{ ...row, steps: 0.5 }] },
    { ...base, rows: [{ ...row, status: "finished" }] },
  ]) {
    const raw = JSON.stringify(value);
    await writeFile(join(dir, "helpers.json"), raw);
    await assert.rejects(s.readHelpers(), s.HelperStoreError);
    assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), raw);
  }
  assert.deepEqual(
    (await readdir(dir)).filter((x) => x.includes("corrupt")),
    [],
  );
});
test("input rejection before directory; empty may; capacity counts pending, max rows includes outcomes", async (t) => {
  const dir = await data(t);
  for (const input of [
    { task: "t", chat },
    { task: " ", may: "", chat },
    { task: "x", may: "x".repeat(501), chat },
    { task: "x".repeat(2001), may: "", chat },
  ])
    assert.equal(
      (await s.addHelper(input as Parameters<typeof s.addHelper>[0], 1000)).ok,
      false,
    );
  assert.deepEqual(await s.readHelpers(), {
    schemaVersion: 1,
    rows: [],
    goals: [],
  });
  assert.deepEqual(
    (await readdir(dir)).filter((x) => x === "helpers"),
    [],
  );
  const rows = await Promise.all([added(), added(), added()]);
  const refused = await s.addHelper({ task: "four", may: "", chat }, 1000);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "capacity");
  for (const r of rows)
    await s.finalizeHelper(
      r.id,
      { kind: "pending", createdAt: 1000 },
      finish,
      1001,
    );
  for (let i = 3; i < 20; i++) await ready(1000 + i);
  assert.equal((await s.readHelpers()).rows.length, 20);
  const full = await s.addHelper({ task: "full", may: "", chat }, 2000);
  assert.equal(full.ok, false);
  if (!full.ok) {
    assert.equal(full.reason, "max-rows");
    assert.match(full.text, /20/);
    assert.match(full.text, /h-/);
  }
  assert.equal((await stat(join(dir, "helpers.json"))).mode & 0o777, 0o600);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  await assert.rejects(stat(join(dir, "helpers")), { code: "ENOENT" });
});
test("claim/fired CAS, repeated client T3, first stop and finalize cannot resurrect/overwrite", async (t) => {
  const dir = await data(t);
  const a = await added();
  const b = await added();
  const owner = { ownerStartedAt: 10 };
  const claims = await Promise.all([
    s.claimHelper(a.id, owner, 1100),
    s.claimHelper(b.id, owner, 1100),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = claims.find(Boolean)!;
  assert.equal(await s.recordHelperSession(row.id, 1099, "stale"), false);
  assert.equal(await s.recordHelperSession(row.id, 1100, "server"), true);
  assert.equal(await s.recordHelperSession(row.id, 1100, "server"), true);
  assert.equal(await s.recordHelperSession(row.id, 1100, "other"), false);
  await s.stopHelper(row.id, 1100, "closed");
  await s.stopHelper(row.id, 1100, "deadline");
  assert.equal(
    await s.finalizeHelper(
      row.id,
      { kind: "pending", createdAt: 1000 },
      finish,
      1200,
    ),
    null,
  );
  const done = await s.finalizeHelper(
    row.id,
    { kind: "running", firedAt: 1100 },
    finish,
    1200,
  );
  assert.equal(done?.outcome, "stopped");
  assert.equal(done?.status, "closed");
  assert.equal(done?.summary, "result");
  assert.equal(done?.run, null);
  assert.equal(
    await s.finalizeHelper(
      row.id,
      { kind: "running", firedAt: 1100 },
      { ...finish, summary: "late" },
      1201,
    ),
    null,
  );
  assert.equal((await s.getHelper(row.id))?.summary, "result");
  assert.deepEqual(await readdir(join(dir, "trace")).catch(() => []), []);
});
test("pure read of multiple outcomes; delivery timestamp once by id/chat, sweep clocks", async (t) => {
  const dir = await data(t);
  const a = await ready();
  const b = await ready(1002);
  const before = await readFile(join(dir, "helpers.json"), "utf8");
  await assert.doesNotReject(() => s.showHelper(a.id, chat));
  assert.equal((await s.showHelper(a.id, other)).ok, false);
  for (const id of [a.id, b.id, a.id])
    assert.equal((await s.showHelper(id, chat)).ok, true);
  assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), before);
  assert.equal(await s.markHelperDelivered(a.id, other, 2000), null);
  assert.equal((await s.markHelperDelivered(a.id, chat, 2000))?.id, a.id);
  assert.equal((await s.markHelperDelivered(b.id, chat, 2001))?.id, b.id);
  assert.equal(await s.markHelperDelivered(a.id, chat, 2002), null);
  assert.equal((await s.getHelper(b.id))?.deliveredAt, 2001);
  await mkdir(join(dir, "helpers", a.id, "out"), { recursive: true });
  await writeFile(s.helperResultPath(a.id), "full result");
  const delivered = await readFile(join(dir, "helpers.json"), "utf8");
  await s.showHelper(a.id, chat);
  assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), delivered);
  assert.deepEqual(await s.sweepHelpers(2000 + s.HELPER_KEEP_MS - 1), []);
  assert.deepEqual(await s.sweepHelpers(2000 + s.HELPER_KEEP_MS), [a.id]);
  await assert.rejects(stat(join(dir, "helpers", a.id)), { code: "ENOENT" });
  assert.deepEqual(await s.sweepHelpers(2001 + s.HELPER_KEEP_MS), [b.id]);
  const c = await ready(3000);
  const d = await ready(4000);
  await s.closeHelper(c.id, chat, 5000);
  assert.deepEqual(await s.sweepHelpers(3001 + s.HELPER_KEEP_MS - 1), []);
  assert.deepEqual(await s.sweepHelpers(3001 + s.HELPER_KEEP_MS), [c.id]);
  assert.ok(await s.getHelper(d.id));
});
test("three close receipts and stop-in-flight remain pending for confirmed server end", async (t) => {
  await data(t);
  const a = await added();
  const b = await added();
  const c = await ready();
  await s.claimHelper(b.id, { ownerStartedAt: 10 }, 2000);
  const results = await Promise.all([
    s.closeHelper(a.id, chat, 2100),
    s.closeHelper(b.id, chat, 2100),
    s.closeHelper(c.id, chat, 2100),
  ]);
  assert.deepEqual(
    results.map((r) => (r.ok ? r.branch : "error")),
    ["pending", "running", "finished"],
  );
  const shown = await s.showHelper(b.id, chat);
  assert.equal(shown.ok, true);
  if (shown.ok) {
    assert.equal(shown.row.outcome, null);
    assert.ok(shown.row.run);
  }
  assert.equal((await s.closeHelper(c.id, other, 2102)).ok, false);
});
test("command sequences preserve capacity, stop, receipts and undelivered lifetime (seed 20261013)", async (t) => {
  const dir = await data(t);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 60 }),
      async (commands) => {
        await rm(join(dir, "helpers"), { force: true, recursive: true });
        await rm(join(dir, "helpers.json"), { force: true });
        let now = 1000;
        for (const cmd of commands) {
          now++;
          const rows = (await s.readHelpers()).rows;
          const r = rows[cmd % Math.max(1, rows.length)];
          if (cmd === 0)
            await s.addHelper({ task: "pbt", may: "opaque", chat }, now);
          else if (r) {
            if (cmd === 1)
              await s.claimHelper(r.id, { ownerStartedAt: 10 }, now);
            if (cmd === 2 && r.run)
              await s.stopHelper(r.id, r.run.firedAt, "deadline");
            if (cmd === 3)
              await s.finalizeHelper(
                r.id,
                r.run
                  ? { kind: "running", firedAt: r.run.firedAt }
                  : { kind: "pending", createdAt: r.createdAt },
                finish,
                now,
              );
            if (cmd === 4) await s.closeHelper(r.id, chat, now);
            if (cmd === 5) await s.showHelper(r.id, chat);
            if (cmd === 6) await s.markHelperDelivered(r.id, chat, now);
            if (cmd === 8) await s.sweepHelpers(now);
          }
          const state = await s.readHelpers();
          assert.ok(
            state.rows.filter((r) => r.status === "pending").length <= 3,
          );
          assert.ok(state.rows.filter((r) => r.run).length <= 1);
          for (const row of state.rows) {
            assert.equal(row.may, "opaque");
            if (row.outcome) assert.equal(row.run, null);
          }
        }
      },
    ),
    { seed: 20261013, numRuns: 30 },
  );
});
