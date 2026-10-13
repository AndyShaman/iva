/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "./helper-store.ts";
await import("../../scripts/lib/ts-esm-hooks.ts");
const { default: hook } = await import("../hooks/trace.ts");
const handle = hook.events!["*"] as unknown as (
  event: unknown,
  ctx: unknown,
) => unknown;
test("two independent T3 writers CAS the exact claim; stale/diagnostic helper and broken file remain safe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-session-"));
  const prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const r = await s.addHelper(
    { task: "task", may: "", chat: { id: "42", threadId: null } },
    1000,
  );
  assert.ok(r.ok);
  await s.claimHelper(
    r.row.id,
    { ownerPid: process.pid, ownerStartedAt: 1 },
    2000,
  );
  const ctx = (fired?: string) => ({
    session: {
      id: "server",
      turn: { id: "turn_0", sequence: 0 },
      auth: {
        current: {
          authenticator: "iva-bearer",
          attributes: {
            iva_turn: "helper",
            iva_helper: r.row.id,
            ...(fired === undefined ? {} : { iva_helper_fired: fired }),
          },
        },
      },
    },
    channel: { kind: "channel:eve" },
  });
  await handle({ type: "session.started" }, ctx("1999"));
  assert.equal((await s.getHelper(r.row.id))?.run?.sessionId, null);
  await handle({ type: "session.started" }, ctx());
  assert.equal((await s.getHelper(r.row.id))?.run?.sessionId, null);
  await Promise.all([
    handle({ type: "session.started" }, ctx("2000")),
    s.recordHelperSession(r.row.id, 2000, "server"),
  ]);
  assert.equal((await s.getHelper(r.row.id))?.run?.sessionId, "server");
  assert.equal(await s.recordHelperSession(r.row.id, 2000, "foreign"), false);
  await writeFile(join(dir, "helpers.json"), "{");
  assert.equal(
    handle(
      { type: "session.started" },
      {
        session: { id: "legacy", turn: { id: "turn_0" }, auth: {} },
        channel: { kind: "channel:telegram" },
      },
    ),
    undefined,
  );
  await handle({ type: "session.started" }, ctx("2000"));
  assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), "{");
});
