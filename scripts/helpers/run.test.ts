/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { helperSummary, helperWork } from "./run.ts";
test("work formula includes first input, positive growth and output after compaction", () => {
  assert.equal(helperWork(0, { inputTokens: 100, outputTokens: 2 }), 102);
  assert.equal(helperWork(100, { inputTokens: 90, outputTokens: 2 }), 2);
  assert.equal(helperWork(90, { inputTokens: 120, outputTokens: 2 }), 32);
});
test("summary bounds Unicode and a single huge paragraph; seed 20261013", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 10000 }), (text) => {
      const s = helperSummary(text);
      assert.ok(s === null || s.length <= 1500);
    }),
    { seed: 20261013, numRuns: 100 },
  );
  assert.equal(helperSummary("a".repeat(3000))?.length, 1500);
  assert.equal(helperSummary(""), null);
  assert.equal(helperSummary("a".repeat(1500)), "a".repeat(1500));
  assert.equal(helperSummary("x\n\n" + "😀".repeat(1500))?.endsWith("…"), true);
});

test("real helper process through installed HTTP client saves text/usage and finalizes before reset", async (t) => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const join: (...parts: string[]) => string = (...parts) =>
    path.join(...parts);
  const store = await import("../../agent/lib/helper-store.ts");
  const { runHelper } = await import("./run.ts");
  const prior = { ...process.env };
  const dir = await fs.mkdtemp(join(tmpdir(), "iva-helper-process-"));
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_HOST: "http://fixture.invalid",
    ASSISTANT_BEARER: "fixture",
    ASSISTANT_TIMEZONE: "UTC",
  });
  t.mock.timers.enable({ apis: ["Date"], now: 2000 });
  t.after(async () => {
    for (const k of [
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_HOST",
      "ASSISTANT_BEARER",
      "ASSISTANT_TIMEZONE",
    ])
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chat = { id: "42", threadId: null };
  let id = "",
    message = "",
    expected: string | null = "done";
  let text = "",
    reason: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const u = String(url),
      h = new Headers(init.headers);
    assert.equal(h.get("x-iva-helper"), id);
    assert.equal(h.has("x-iva-helper-fired"), false);
    if (u.endsWith("/session")) {
      message = (
        JSON.parse(typeof init.body === "string" ? init.body : "null") as {
          message: string;
        }
      ).message;
      return Response.json({ sessionId: "server" });
    }
    if (u.includes("/stream"))
      return new Response(
        [
          { type: "message.completed", data: { message: text } },
          {
            type: "step.completed",
            data: {
              usage: { inputTokens: 10, outputTokens: 2 },
              providerModelId: "a/b",
            },
          },
          {
            type: "step.completed",
            data: {
              usage: { inputTokens: 8, outputTokens: 3 },
              providerModelId: "a/b",
            },
          },
          { type: "turn.completed", data: { reason } },
          { type: "session.waiting" },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
        { headers: { "x-eve-stream-version": "25" } },
      );
    assert.ok(u.endsWith("/reset"));
    const row = await store.getHelper(id);
    assert.equal(row?.outcome, expected);
    assert.equal(row?.run, null);
    return Response.json({ ok: true, status: "no_active_session" });
  });
  const checkScenario = async (scenario: {
    text: string;
    outcome: string;
    reason: string | undefined;
  }) => {
    text = scenario.text;
    expected = scenario.outcome;
    reason = scenario.reason;
    const added = await store.addHelper(
      { task: "test task", may: "", chat },
      1000,
    );
    assert.ok(added.ok);
    id = added.row.id;
    await store.claimHelper(id, { ownerStartedAt: 1 }, 2000);
    await runHelper(id);
    const r = await store.getHelper(id);
    assert.ok(r);
    assert.equal(r.outcome, expected);
    assert.equal(r.steps, 2);
    assert.equal(r.tokens, 15);
    assert.equal(r.model, "a/b");
    assert.match(
      message,
      /Allowed: nothing, look and draft only\. Task: test task/,
    );
    if (expected === "empty") {
      assert.equal(r.summary, null);
      await assert.rejects(fs.stat(store.helperResultPath(id)));
    } else {
      assert.equal(await fs.readFile(store.helperResultPath(id), "utf8"), text);
      assert.ok(r.summary!.length <= 1500);
    }
    if (expected === "ceiling") assert.equal(r.reason, "предел шагов");
  };
  for (const scenario of [
    { text: "a".repeat(3000), outcome: "done", reason: undefined },
    { text: "result", outcome: "ceiling", reason: "step-limit" },
    { text: "QUIET", outcome: "empty", reason: undefined },
  ])
    await checkScenario(scenario);
  await fc.assert(
    fc.asyncProperty(
      fc.string({ unit: "grapheme", minLength: 1501, maxLength: 3000 }),
      async (generated) => {
        await fs.rm(join(dir, "helpers.json"), { force: true });
        await checkScenario({
          text: generated,
          outcome: "done",
          reason: undefined,
        });
        assert.equal(
          (await fs.stat(path.dirname(store.helperResultPath(id)))).mode &
            0o777,
          0o700,
        );
      },
    ),
    { seed: 20261013, numRuns: 20 },
  );
  const a = await store.addHelper({ task: "no key", may: "", chat }, 1000);
  assert.ok(a.ok);
  id = a.row.id;
  await store.claimHelper(id, { ownerStartedAt: 1 }, 2000);
  delete process.env.ASSISTANT_BEARER;
  await runHelper(id);
  assert.equal((await store.getHelper(id))?.outcome, "failed");
});
