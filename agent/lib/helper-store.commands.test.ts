/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as s from "./helper-store.ts";
type Row = {
  id: string;
  createdAt: number;
  status: s.HelperStatus;
  fired: number | null;
  session: string | null;
  stop: s.HelperStop | null;
  outcome: s.HelperOutcome | null;
  shown: s.HelperTurnKey | null;
  delivered: s.HelperTurnKey | null;
  wakes: number;
  wake: { updateId: number; sent: boolean } | null;
  lastWake: number | null;
  finished: number | null;
};
type Model = { now: number; seq: number; rows: Row[] };
const chat = { id: "42", threadId: null };
const end = {
  outcome: "done" as const,
  summary: "result",
  reason: null,
  model: "fixture",
  steps: 1,
  tokens: 12,
};
const key = { sessionId: "A", turnId: "turn_0" };
const ops = [
  "add",
  "claim",
  "pid",
  "server-session",
  "client-session",
  "stop",
  "finish",
  "stale-finish",
  "close",
  "wake",
  "stamp",
  "show",
  "deliver",
  "escalate",
  "sweep",
] as const;
class Command implements fc.AsyncCommand<Model, typeof s> {
  readonly op: (typeof ops)[number];
  readonly index: number;
  constructor(op: (typeof ops)[number], index: number) {
    this.op = op;
    this.index = index;
  }
  check() {
    return true;
  }
  toString() {
    return `${this.op}(${this.index})`;
  }
  async run(m: Model, r: typeof s) {
    m.now += 400000;
    const now = m.now;
    const row = m.rows[this.index % m.rows.length];
    if (this.op === "add") {
      const a = await r.addHelper({ task: "task", may: "opaque", chat }, now);
      const allowed =
        m.rows.length < 20 &&
        m.rows.filter((x) => x.status === "pending").length < 3;
      assert.equal(a.ok, allowed);
      if (a.ok)
        m.rows.push({
          id: a.row.id,
          createdAt: now,
          status: "pending",
          fired: null,
          session: null,
          stop: null,
          outcome: null,
          shown: null,
          delivered: null,
          wakes: 0,
          wake: null,
          lastWake: null,
          finished: null,
        });
    } else if (row) {
      switch (this.op) {
        case "claim": {
          const allowed =
            row.status === "pending" &&
            row.fired === null &&
            row.stop === null &&
            m.rows.filter((x) => x.fired !== null).length < 1;
          const a = await r.claimHelper(
            row.id,
            { ownerPid: 123, ownerStartedAt: 10, maxRunning: 1 },
            now,
          );
          assert.equal(a !== null, allowed);
          if (allowed) row.fired = now;
          break;
        }
        case "pid": {
          const actual = await r.getHelper(row.id);
          const allowed = row.fired !== null && actual?.run?.childPid === null;
          const a = await r.recordHelperChild(row.id, row.fired ?? 0, 222);
          assert.equal(a !== null, allowed);
          break;
        }
        case "server-session":
        case "client-session": {
          const allowed = row.fired !== null && row.outcome === null;
          assert.equal(
            await r.recordHelperSession(row.id, row.fired ?? 0, "server"),
            allowed,
          );
          if (allowed) row.session = "server";
          break;
        }
        case "stop": {
          const allowed = row.fired !== null && row.outcome === null;
          const a = await r.stopHelper(row.id, row.fired ?? 0, "deadline");
          assert.equal(a !== null, allowed);
          if (allowed) row.stop ??= "deadline";
          break;
        }
        case "finish":
        case "stale-finish": {
          const allowed =
            this.op === "finish" &&
            row.status === "pending" &&
            row.outcome === null;
          const a = await r.finalizeHelper(
            row.id,
            row.fired !== null
              ? {
                  kind: "running",
                  firedAt:
                    this.op === "stale-finish" ? row.fired - 1 : row.fired,
                }
              : {
                  kind: "pending",
                  createdAt:
                    this.op === "stale-finish"
                      ? row.createdAt - 1
                      : row.createdAt,
                },
            end,
            now,
          );
          assert.equal(a !== null, allowed);
          if (allowed) {
            row.outcome =
              row.stop === "closed" ? "stopped" : (row.stop ?? "done");
            row.status = row.stop === "closed" ? "closed" : "finished";
            row.finished = now;
            row.fired = null;
          }
          break;
        }
        case "close": {
          const a = await r.closeHelper(row.id, chat, now);
          assert.equal(a.ok, row.delivered === null);
          if (a.ok) {
            if (row.fired !== null) row.stop ??= "closed";
            else {
              row.status = "closed";
              if (row.outcome === null) {
                row.outcome = "stopped";
                row.stop = "closed";
                row.finished = now;
              }
            }
          }
          break;
        }
        case "wake": {
          const due =
            row.lastWake === null
              ? (row.finished ?? Infinity)
              : Math.max(
                  row.finished ?? Infinity,
                  row.lastWake + Math.min(180000 * 2 ** row.wakes, 3600000),
                );
          const allowed =
            row.status === "finished" && row.delivered === null && due <= now;
          const a = await r.allocateHelperWake(row.id, now);
          assert.equal(a !== null, allowed);
          if (allowed) {
            if (!row.wake || row.wake.sent) {
              m.seq++;
              row.wake = { updateId: 2 ** 52 + m.seq, sent: false };
            }
            row.lastWake = now;
          }
          break;
        }
        case "stamp": {
          const allowed =
            row.status === "finished" &&
            row.delivered === null &&
            row.wake !== null &&
            !row.wake.sent;
          const a = await r.stampHelperWake(
            row.id,
            row.wake?.updateId ?? 0,
            now,
          );
          assert.equal(a !== null, allowed);
          if (allowed) {
            row.wake!.sent = true;
            row.wakes++;
          }
          break;
        }
        case "show": {
          const ready = row.status === "finished" && row.delivered === null;
          const first = m.rows.find(
            (x) =>
              x.status === "finished" &&
              !x.delivered &&
              x.shown?.sessionId === key.sessionId &&
              x.shown.turnId === key.turnId,
          );
          const allowed =
            (row.outcome !== null || row.stop === "closed") &&
            (!ready || !first || first.id === row.id);
          const a = await r.showHelper(row.id, chat, key, now);
          assert.equal(a.ok, allowed);
          if (allowed && ready) row.shown = key;
          break;
        }
        case "deliver": {
          const found = m.rows.find(
            (x) =>
              x.status === "finished" &&
              !x.delivered &&
              x.shown?.sessionId === key.sessionId &&
              x.shown.turnId === key.turnId,
          );
          const a = await r.markHelperDelivered(chat, key, now);
          assert.equal(a?.id, found?.id);
          if (found) found.delivered = key;
          break;
        }
        case "escalate":
          await r.markHelperEscalated(row.id, now);
          break;
        case "sweep": {
          const removed = await r.sweepHelpers(now);
          const expected = m.rows
            .filter(
              (x) =>
                x.status === "closed" &&
                x.finished !== null &&
                x.finished + 86400000 <= now,
            )
            .map((x) => x.id);
          assert.deepEqual(removed, expected);
          m.rows = m.rows.filter((x) => !expected.includes(x.id));
          break;
        }
      }
    }
    const actual = await r.readHelpers();
    assert.equal(actual.wakeSeq, m.seq);
    assert.equal(actual.rows.length, m.rows.length);
    for (const x of m.rows) {
      const a = actual.rows.find((a) => a.id === x.id)!;
      assert.equal(a.status, x.status);
      assert.equal(a.run?.firedAt ?? null, x.fired);
      assert.equal(a.run?.sessionId ?? null, x.session);
      assert.equal(a.stop, x.stop);
      assert.equal(a.outcome, x.outcome);
      assert.equal(a.wakes, x.wakes);
      assert.equal(a.lastWakeAt, x.lastWake);
      assert.deepEqual(a.wake, x.wake);
      assert.equal(a.may, "opaque");
      assert.equal(a.finishedAt, x.finished);
    }
  }
}
test("fc.commands: lifecycle, dual T3, stale CAS, close, wake, delivery and sweep; seed 20261013", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-commands-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await rm(dir, { force: true, recursive: true });
  });
  const commands = fc.commands(
    [
      fc
        .tuple(fc.constantFrom(...ops), fc.nat(5))
        .map(([op, index]) => new Command(op, index)),
    ],
    { maxCommands: 35 },
  );
  await fc.assert(
    fc.asyncProperty(commands, async (cs) => {
      await rm(join(dir, "helpers"), { recursive: true, force: true });
      await rm(join(dir, "helpers.json"), { force: true });
      await fc.asyncModelRun(
        () => ({ model: { now: 1000, seq: 0, rows: [] }, real: s }),
        cs,
      );
    }),
    { seed: 20261013, numRuns: 60 },
  );
});
