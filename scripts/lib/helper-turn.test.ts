/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runReminderTurn,
  type ReminderClient,
  type TurnStreamEvent,
} from "./reminder-turn.ts";
const options = {
  host: "http://fixture.invalid",
  auth: { bearer: () => Promise.resolve("fixture") },
  headers: { "x-iva-turn": "helper" },
};
test("R1 close during a busy stream cancels within one check and retains the slot until confirmed end", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const s = await import("../../agent/lib/helper-store.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "iva-helper-busy-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.mock.timers.enable({ apis: ["Date"], now: 2000 });
  t.after(async () => {
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  const chat = { id: "42", threadId: null };
  const added = await s.addHelper({ task: "busy", may: "", chat }, 1000);
  assert.ok(added.ok);
  const id = added.row.id;
  await s.claimHelper(id, { ownerStartedAt: 1 }, 2000);
  const controller = new AbortController();
  const checkMs = 20;
  let closedAt = 0,
    cancels = 0,
    firstCancelAt = 0,
    finalized = false;
  const response = Object.assign(
    (async function* () {
      yield { type: "message.completed", data: { message: "saved partial" } };
      await s.closeHelper(id, chat, Date.now());
      closedAt = Date.now();
      controller.abort();
      for (let i = 0; i < 100; i++) {
        t.mock.timers.tick(1);
        yield { type: "message.appended", data: { messageDelta: "busy" } };
      }
      await new Promise(() => {});
    })(),
    { sessionId: "busy", cancel: () => Promise.resolve() },
  );
  const client: ReminderClient = {
    sessions: {
      create: () =>
        Promise.resolve({
          response,
          session: {
            send: () => Promise.resolve(),
            cancel: async () => {
              assert.ok((await s.getHelper(id))?.run);
              assert.equal(finalized, false);
              if (++cancels === 1) firstCancelAt = Date.now();
              return { status: cancels === 1 ? "accepted" : "no_active_turn" };
            },
            reset: () => Promise.resolve(),
          },
        }),
    },
  };
  const result = await runReminderTurn("busy", options, {
    createClient: () => Promise.resolve(client),
    helperCheckMs: checkMs,
    signal: controller.signal,
    onSession: (sessionId) => s.recordHelperSession(id, 2000, sessionId),
    onCompleted: async (turn) => {
      assert.equal(cancels, 2);
      assert.equal(turn.partial, "saved partial");
      await s.finalizeHelper(
        id,
        { kind: "running", firedAt: 2000 },
        {
          outcome: "failed",
          summary: turn.partial ?? null,
          reason: null,
          model: null,
          steps: 0,
          tokens: 0,
        },
        Date.now(),
      );
      finalized = true;
    },
  });
  assert.ok(
    firstCancelAt - closedAt <= checkMs,
    `cancel delayed ${firstCancelAt - closedAt}ms by stream events`,
  );
  assert.equal(result.partial, "saved partial");
  assert.equal((await s.getHelper(id))?.run, null);
  assert.equal((await s.getHelper(id))?.outcome, "stopped");
});
function fixture(
  events: TurnStreamEvent[],
  cancel: () => Promise<unknown> = () =>
    Promise.resolve({ status: "no_active_turn" }),
  stall = false,
) {
  const calls: string[] = [];
  const response = Object.assign(
    (async function* () {
      for (const e of events) yield e;
      if (stall) await new Promise(() => {});
    })(),
    { sessionId: "s", cancel: () => Promise.resolve() },
  );
  const client: ReminderClient = {
    sessions: {
      create: () =>
        Promise.resolve({
          response,
          session: {
            send: () => Promise.resolve(),
            cancel: () => {
              calls.push("cancel");
              return cancel();
            },
            reset: () => {
              calls.push("reset");
              return Promise.resolve();
            },
          },
        }),
    },
  };
  return { calls, client };
}
test("helper completed waiting: last completed text, reason, usage and finalize before reset", async () => {
  const f = fixture([
    { type: "message.completed", data: { message: "first" } },
    { type: "message.appended", data: { message: "delta" } },
    { type: "message.completed", data: { message: "final" } },
    {
      type: "step.completed",
      data: {
        usage: { inputTokens: 10, outputTokens: 2 },
        providerModelId: "fixture",
      },
    },
    { type: "turn.completed", data: { reason: "step-limit" } },
    { type: "session.waiting" },
  ]);
  const ids: string[] = [];
  const usage: unknown[] = [];
  const r = await runReminderTurn("task", options, {
    createClient: () => Promise.resolve(f.client),
    onSession: (id) => {
      ids.push(id);
      return Promise.resolve(true);
    },
    onStepUsage: (u) => {
      usage.push(u);
    },
    onCompleted: () => {
      f.calls.push("finalize");
      return Promise.resolve();
    },
    helperCheckMs: 1,
  });
  assert.equal(r.reason, "step-limit");
  assert.equal(r.partial, "final");
  assert.equal(r.message, "final");
  assert.deepEqual(ids, ["s"]);
  assert.equal(usage.length, 1);
  assert.deepEqual(f.calls, ["finalize", "reset"]);
});
test("helper question waiting fails and confirms cancel before finalize", async () => {
  const f = fixture([
    { type: "message.completed", data: { message: "partial" } },
    { type: "input.requested", data: { requests: [{ kind: "question" }] } },
    { type: "turn.completed" },
    { type: "session.waiting" },
  ]);
  const r = await runReminderTurn("task", options, {
    createClient: () => Promise.resolve(f.client),
    onSession: () => Promise.resolve(true),
    onCompleted: () => {
      f.calls.push("finalize");
      return Promise.resolve();
    },
    helperCheckMs: 1,
  });
  assert.equal(r.status, "failed");
  assert.match(r.message ?? "", /помощник ждал ответа/);
  assert.equal(r.partial, "partial");
  assert.deepEqual(f.calls, ["cancel", "finalize", "reset"]);
});
test("helper early stream end preserves run: no completion callback or reset", async () => {
  const f = fixture([
    { type: "message.completed", data: { message: "partial" } },
  ]);
  const r = await runReminderTurn("task", options, {
    createClient: () => Promise.resolve(f.client),
    onSession: () => Promise.resolve(true),
    onCompleted: () => {
      f.calls.push("finalize");
      return Promise.resolve();
    },
    helperCheckMs: 1,
  });
  assert.equal(r.partial, "partial");
  assert.deepEqual(f.calls, []);
});
test("helper abort holds until cancel no_active_turn; late completed text excluded", async () => {
  const abort = new AbortController();
  let cancellations = 0;
  const f = fixture(
    [
      { type: "message.completed", data: { message: "saved" } },
      {
        type: "step.completed",
        data: { usage: { inputTokens: 10, outputTokens: 2 } },
      },
      { type: "message.completed", data: { message: "late" } },
    ],
    () =>
      Promise.resolve({
        status: ++cancellations === 1 ? "accepted" : "no_active_turn",
      }),
    true,
  );
  const r = await runReminderTurn("task", options, {
    signal: abort.signal,
    createClient: () => Promise.resolve(f.client),
    onSession: () => Promise.resolve(true),
    onStepUsage: () => {
      abort.abort();
    },
    onCompleted: () => {
      assert.ok(cancellations >= 2);
      f.calls.push("finalize");
      return Promise.resolve();
    },
    helperCheckMs: 1,
  });
  assert.equal(r.partial, "saved");
  assert.equal(f.calls.at(-1), "reset");
});
test("unrecorded live session is canceled and failed only after observed end", async () => {
  const f = fixture(
    [],
    () => Promise.resolve({ status: "no_active_turn" }),
    true,
  );
  const r = await runReminderTurn("task", options, {
    createClient: () => Promise.resolve(f.client),
    onSession: () => Promise.resolve(false),
    helperCheckMs: 1,
  });
  assert.equal(r.status, "failed");
  assert.match(r.message ?? "", /ход не записан/);
});

test("already stopped helper does not create a server turn and finalizes the confirmed no-start", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture([]);
  let finalized = 0;
  const r = await runReminderTurn("task", options, {
    signal: controller.signal,
    createClient: () => {
      throw Error("must not create");
    },
    onCompleted: () => {
      finalized++;
      return Promise.resolve();
    },
  });
  assert.equal(r.status, "failed");
  assert.equal(finalized, 1);
  assert.deepEqual(f.calls, []);
});
test("helper failed finalize never resets first", async () => {
  const f = fixture([
    { type: "turn.failed", data: { message: "model rejected" } },
  ]);
  await assert.rejects(
    runReminderTurn("task", options, {
      createClient: () => Promise.resolve(f.client),
      onCompleted: () => Promise.reject(Error("disk")),
    }),
    /disk/,
  );
  assert.deepEqual(f.calls, []);
});
test("helper session limit and silence cancel and retain only completed partial", async () => {
  for (const events of [
    [
      {
        type: "input.requested",
        data: { requests: [{ kind: "session-limit" }] },
      },
    ],
    [],
  ]) {
    const f = fixture(
      [{ type: "message.completed", data: { message: "saved" } }, ...events],
      undefined,
      true,
    );
    const r = await runReminderTurn("task", options, {
      createClient: () => Promise.resolve(f.client),
      inactivityMs: 0,
      helperCheckMs: 1,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.partial, "saved");
    assert.deepEqual(f.calls, ["cancel", "reset"]);
  }
});

test("actual installed client: helper headers/create/stream and finalize before HTTP reset", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-iva-turn"), "helper");
    if (u.endsWith("/session")) {
      assert.deepEqual(
        JSON.parse(typeof init.body === "string" ? init.body : "null"),
        { message: "task" },
      );
      return Promise.resolve(Response.json({ sessionId: "s" }));
    }
    if (u.includes("/stream"))
      return Promise.resolve(
        new Response(
          [
            { type: "message.completed", data: { message: "full" } },
            { type: "turn.completed", data: { reason: "step-limit" } },
            { type: "session.waiting" },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n") + "\n",
          { headers: { "x-eve-stream-version": "25" } },
        ),
      );
    assert.ok(u.endsWith("/reset"));
    assert.equal(calls.at(-2), "finalize");
    return Promise.resolve(
      Response.json({ ok: true, status: "no_active_session" }),
    );
  });
  const r = await runReminderTurn("task", options, {
    onSession: (id) => {
      assert.equal(id, "s");
      return Promise.resolve(true);
    },
    onCompleted: () => {
      calls.push("finalize");
      return Promise.resolve();
    },
  });
  assert.equal(r.reason, "step-limit");
  assert.equal(r.partial, "full");
  assert.equal(calls.length, 4);
});

test("helper marker on initiator with current chat still uses the static helper instructions", async () => {
  await import("./ts-esm-hooks.ts");
  const { default: role } =
    await import("../../agent/instructions/00-helper.ts");
  const auth = {
    authenticator: "iva-bearer",
    attributes: { iva_turn: "helper" },
  };
  for (const side of ["initiator", "current"]) {
    const ctx = { session: { auth: { [side]: auth } } };
    const block = role.events["turn.started"]!({}, ctx as never);
    assert.match(JSON.stringify(block), /background helper of Iva/);
  }
});
