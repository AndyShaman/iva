/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as s from "../../agent/lib/helper-store.ts";
import { runHelperTick } from "../../agent/lib/helper-tick.ts";
import { OWNER_STARTED_AT } from "../../agent/lib/schedule-runner.ts";
import { runHelper } from "./run.ts";

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-stop-"));
  const prev = { ...process.env };
  const keys = [
    "ASSISTANT_DATA_DIR",
    "ASSISTANT_BEARER",
    "ASSISTANT_HOST",
    "ASSISTANT_TIMEZONE",
  ];
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_BEARER: "fixture",
    ASSISTANT_HOST: "http://fixture.invalid",
    ASSISTANT_TIMEZONE: "UTC",
  });
  t.after(async () => {
    for (const k of keys)
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    await rm(dir, { recursive: true, force: true });
  });
  const chat = { id: "42", threadId: null };
  const added = await s.addHelper(
    { task: "fixture task", may: "", chat },
    Date.now(),
  );
  assert.ok(added.ok);
  const fired = Date.now();
  await s.claimHelper(
    added.row.id,
    { ownerStartedAt: OWNER_STARTED_AT },
    fired,
  );
  return { dir, chat, id: added.row.id, fired };
}

test(
  "close through the real tick preserves text already consumed by the living client",
  { timeout: 30000 },
  async (t) => {
    const { dir, chat, id } = await setup(t);
    const fixture = join(dir, "child.ts");
    await writeFile(
      fixture,
      `
    import { runHelper } from ${JSON.stringify(new URL("./run.ts", import.meta.url).href)};
    import { access, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const gate = join(process.env.ASSISTANT_DATA_DIR, "allow-cancel");
    let completed = false, stream;
    const timeout = setTimeout, interval = setInterval;
    globalThis.setTimeout = (fn, delay, ...args) => timeout(fn, delay <= 15000 && fn.toString().includes("resolve(null)") ? 20 : delay, ...args);
    globalThis.setInterval = (fn, delay, ...args) => interval(fn, delay === 15000 ? 20 : delay, ...args);
    const parse = JSON.parse;
    JSON.parse = (...args) => {
      const e = parse(...args);
      if (e?.type === "step.completed") Object.defineProperty(e.data, "usage", { get() {
        if (!completed) { completed = true; void writeFile(join(process.env.ASSISTANT_DATA_DIR, "consumed"), "yes"); }
        return { inputTokens: 10, outputTokens: 2 };
      } });
      return e;
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/session")) return Response.json({ sessionId: "fixture-server" });
      if (u.endsWith("/cancel")) {
        while (!(await access(gate).then(() => true, () => false)))
          await new Promise(resolve => timeout(resolve, 10));
        stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "turn.cancelled" }) + "\\n"));
        return Response.json({ ok: true, status: "accepted", sessionId: "fixture-server" });
      }
      if (u.endsWith("/reset")) return Response.json({ ok: true, status: "no_active_session" });
      if (!u.includes("/stream")) throw Error("unexpected request " + u);
      return new Response(new ReadableStream({ start(c) {
        stream = c;
        const events = [
          { type: "message.completed", data: { message: "completed partial already received" } },
          { type: "step.completed", data: { usage: { inputTokens: 10, outputTokens: 2 }, providerModelId: "fixture-processed" } }
        ];
        c.enqueue(new TextEncoder().encode(events.map(e => JSON.stringify(e)).join("\\n") + "\\n"));
      }}), { headers: { "x-eve-stream-version": "25" } });
    };
    await runHelper(process.argv[2]);
  `,
    );
    const child = spawn(process.execPath, [fixture, id], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    const exited = once(child, "exit");
    let ended = false;
    child.once("exit", () => {
      ended = true;
    });
    t.after(async () => {
      if (!ended) {
        process.kill(-child.pid!, "SIGKILL");
        await exited;
      }
    });
    await once(child, "spawn");
    let consumed = false;
    for (let i = 0; i < 300 && !consumed; i++) {
      consumed = await readFile(join(dir, "consumed"), "utf8").then(
        () => true,
        () => false,
      );
      if (!consumed) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      consumed,
      "step dispatch confirms the preceding completed text was consumed",
    );
    await s.closeHelper(id, chat, Date.now());
    await runHelperTick({
      cancel: () => assert.fail("stop alone is owned by the living client"),
    });
    await writeFile(join(dir, "allow-cancel"), "tick finished");
    await exited;
    assert.equal(child.signalCode, null);
    assert.equal(child.exitCode, 0);
    const row = await s.getHelper(id);
    assert.ok(row);
    assert.equal(row?.outcome, "stopped");
    assert.equal(row?.summary, "completed partial already received");
    assert.equal(await readFile(s.helperResultPath(id), "utf8"), row.summary);
    assert.equal(row.steps, 1);
    assert.equal(row.tokens, 12);
  },
);

for (const failure of ["network", "missing-key", "rejected-key"]) {
  test(`failure before session creation: ${failure} is failed with a human cause`, async (t) => {
    const { id, fired } = await setup(t);
    if (failure === "missing-key") delete process.env.ASSISTANT_BEARER;
    let requests = 0;
    t.mock.method(globalThis, "fetch", () => {
      requests++;
      if (failure === "rejected-key")
        return Promise.resolve(
          Response.json({ error: "Unauthorized" }, { status: 401 }),
        );
      throw Error("fixture network unavailable before create");
    });
    t.mock.method(console, "error", () => {});
    await runHelper(id);
    assert.equal(requests, failure === "missing-key" ? 0 : 1);
    await runHelperTick({ completed: { id, firedAt: fired } });
    const row = await s.getHelper(id);
    assert.ok(row);
    assert.equal(row?.outcome, "failed");
    assert.match(row?.reason ?? "", failure === "network" ? /сеть/ : /ключ/);
    assert.doesNotMatch(row.reason ?? "", /\/menu/);
    assert.equal(row.run, null);
  });
}
