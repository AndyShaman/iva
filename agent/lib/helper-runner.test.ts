/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import * as runner from "./schedule-runner.ts";
test("start API gives OS-confirmed pid before completion and reports missing executable", async () => {
  const child = await runner.startScheduledJob({
    name: "helper-fixture",
    argv: ["-e", "process.stdin.resume()"],
    nodeBin: process.execPath,
    env: {},
    log: () => {},
  });
  assert.ok(!child.startFailed);
  if (child.startFailed) return;
  assert.ok(child.pid > 0);
  let finished = false;
  void child.completion.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  process.kill(child.pid, "SIGTERM");
  await child.completion;
  const bad = await runner.startScheduledJob({
    name: "helper-failed",
    argv: [],
    nodeBin: "/__missing_iva_fixture__",
    env: {},
    log: () => {},
  });
  assert.equal(bad.startFailed, true);
});
