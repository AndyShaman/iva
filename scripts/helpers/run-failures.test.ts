/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHelper } from "./run.ts";
import { runHelperTick } from "../../agent/lib/helper-tick.ts";
import * as s from "../../agent/lib/helper-store.ts";
const chat = { id: "42", threadId: null };
for (const { scenario, reason } of [
  "failed",
  "question",
  "session-limit",
  "stream-error",
  "closed",
  "ceiling",
  "rename",
].flatMap((scenario) =>
  scenario === "failed"
    ? [
        "model rejected",
        "Модель не принята",
        "unknown model",
        "network unavailable",
        "missing API key",
        "provider failure",
        "model rejected; /menu",
      ].map((reason) => ({ scenario, reason }))
    : [{ scenario, reason: "" }],
)) {
  test(`real client + process/store: ${scenario}${reason ? ": " + reason : ""}, terminal stream or tick reset proves end before atomic outcome`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "iva-helper-failure-"));
    const prev = { ...process.env };
    Object.assign(process.env, {
      ASSISTANT_DATA_DIR: dir,
      ASSISTANT_HOST: "http://fixture.invalid",
      ASSISTANT_BEARER: "fixture",
      ASSISTANT_TIMEZONE: "UTC",
    });
    t.mock.timers.enable({ apis: ["Date"], now: 2000 });
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const k of [
        "ASSISTANT_DATA_DIR",
        "ASSISTANT_HOST",
        "ASSISTANT_BEARER",
        "ASSISTANT_TIMEZONE",
      ])
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      await rm(dir, { recursive: true, force: true });
    });
    const added = await s.addHelper({ task: "test", may: "draft", chat }, 1000);
    assert.ok(added.ok);
    const id = added.row.id;
    await s.claimHelper(id, { ownerStartedAt: 1 }, 2000);
    let cancels = 0,
      reset = 0;
    const timeout = setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn: () => void, delay: number) =>
      timeout(fn, delay === 15000 ? 1 : delay),
    );
    if (scenario === "rename") {
      const rename = fs.rename.bind(fs);
      t.mock.method(fs, "rename", (from: string, to: string) =>
        to.endsWith("/out/result.md")
          ? Promise.reject(Error("disk"))
          : rename(from, to),
      );
      syncBuiltinESMExports();
      t.mock.method(console, "error", () => {});
    }
    t.mock.method(globalThis, "fetch", async (url: string) => {
      const u = String(url);
      if (u.endsWith("/session")) return Response.json({ sessionId: "server" });
      if (u.endsWith("/cancel")) {
        assert.ok((await s.getHelper(id))?.run);
        cancels++;
        return Response.json({
          ok: true,
          status: "accepted",
          sessionId: "server",
        });
      }
      if (u.endsWith("/reset")) {
        reset++;
        if (["question", "session-limit", "stream-error"].includes(scenario))
          assert.ok((await s.getHelper(id))?.run);
        else assert.equal((await s.getHelper(id))?.run, null);
        return Response.json({ ok: true, status: "no_active_session" });
      }
      assert.ok(u.includes("/stream"));
      if (scenario === "closed") await s.closeHelper(id, chat, 2000);
      if (scenario === "ceiling") await s.stopHelper(id, 2000, "ceiling");
      const events: { type: string; data?: Record<string, unknown> }[] = [
        { type: "message.completed", data: { message: "first" } },
        { type: "message.appended", data: { messageDelta: "unfinished" } },
        { type: "message.completed", data: { message: "second" } },
      ];
      if (["question", "session-limit"].includes(scenario))
        events.push(
          { type: "input.requested", data: { requests: [{ kind: scenario }] } },
          { type: "turn.completed" },
          { type: "session.waiting" },
        );
      else if (scenario === "failed")
        events.push({
          type: "turn.failed",
          data: { message: reason },
        });
      else if (scenario !== "stream-error")
        events.push(
          { type: scenario === "closed" ? "turn.cancelled" : "turn.completed" },
          { type: "session.waiting" },
        );
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(
                new TextEncoder().encode(
                  events.map((e) => JSON.stringify(e)).join("\n") + "\n",
                ),
              );
            } else if (scenario === "stream-error")
              c.error(Error("wire damaged"));
            else c.close();
          },
        }),
        { headers: { "x-eve-stream-version": "25" } },
      );
    });
    t.mock.method(console, "error", () => {});
    await runHelper(id);
    const lostStream = ["question", "session-limit", "stream-error"].includes(
      scenario,
    );
    if (lostStream) await runHelperTick({ completed: { id, firedAt: 2000 } });
    const row = await s.getHelper(id);
    assert.ok(row);
    assert.equal(row.run, null);
    assert.equal(reset, 1);
    assert.equal(
      row.outcome,
      scenario === "closed"
        ? "stopped"
        : scenario === "ceiling"
          ? "ceiling"
          : lostStream
            ? "interrupted"
            : scenario === "rename"
              ? "done"
              : "failed",
    );
    if (lostStream) {
      assert.equal(row.summary, null);
      await assert.rejects(readFile(s.helperResultPath(id)));
    } else if (scenario !== "rename") {
      assert.equal(await readFile(s.helperResultPath(id), "utf8"), "second");
      assert.equal(row.summary, "second");
    } else {
      assert.equal(row.summary, "second");
      assert.match(row.reason ?? "", /полный текст не записан/);
      await assert.rejects(readFile(s.helperResultPath(id)));
    }
    if (["question", "session-limit", "stream-error"].includes(scenario))
      assert.ok(cancels >= 1);
    if (scenario === "closed") assert.equal(row.status, "closed");
    if (scenario === "failed") assert.equal(row.reason, reason);
    else assert.doesNotMatch(row.reason ?? "", /\/menu/);
  });
}
