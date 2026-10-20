/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, releaseLock } from "./json-store.ts";
const chat = { id: "42", threadId: null };
async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), "iva-helper-fault-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test("T1 failed rename preserves table bytes and creates no task directory", async (t) => {
  const dir = await setup(t);
  const s = await import("./helper-store.ts");
  await fs.writeFile(
    join(dir, "helpers.json"),
    JSON.stringify({ schemaVersion: 1, rows: [] }),
  );
  const before = await fs.readFile(join(dir, "helpers.json"), "utf8");
  const original = fs.rename;
  t.mock.method(fs, "rename", (a: PathLike, b: PathLike) =>
    String(b).endsWith("helpers.json")
      ? Promise.reject(Error("disk rename failed"))
      : original(a, b),
  );
  syncBuiltinESMExports();
  await assert.rejects(
    s.addHelper({ task: "task", may: "", chat }, 1000),
    /disk rename failed/,
  );
  assert.equal(await fs.readFile(join(dir, "helpers.json"), "utf8"), before);
  await assert.rejects(fs.stat(join(dir, "helpers")), { code: "ENOENT" });
});
test("non-ENOENT reader error stays an error without fallback", async (t) => {
  await setup(t);
  const s = await import("./helper-store.ts");
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) =>
    typeof args[0] === "string" && args[0].endsWith("helpers.json")
      ? Promise.reject(Object.assign(Error("denied"), { code: "EACCES" }))
      : original(...args),
  );
  syncBuiltinESMExports();
  await assert.rejects(s.readHelpers(), s.HelperStoreError);
});
test("lock timeout refuses a transition with existing bytes intact", async (t) => {
  const dir = await setup(t);
  const s = await import("./helper-store.ts");
  const path = join(dir, "helpers.json.lock");
  const token = await acquireLock(path);
  try {
    await assert.rejects(
      s.addHelper({ task: "task", may: "", chat }, 1000),
      /lock timeout/,
    );
    assert.deepEqual(await s.readHelpers(), {
      schemaVersion: 1,
      rows: [],
      goals: [],
    });
  } finally {
    releaseLock(path, token);
  }
});

test("failed save preserves delivered rows and directories on eviction and close", async (t) => {
  const dir = await setup(t);
  const s = await import("./helper-store.ts");
  for (let i = 0; i < 20; i++) {
    const added = await s.addHelper({ task: "task", may: "", chat }, 1000 + i);
    assert.ok(added.ok);
    await s.finalizeHelper(
      added.row.id,
      { kind: "pending", createdAt: 1000 + i },
      {
        outcome: "done",
        summary: "result",
        reason: null,
        model: null,
        steps: 1,
        tokens: 1,
      },
      2000 + i,
    );
    await s.markHelperDelivered(added.row.id, chat, 3000 + i);
  }
  const row = (await s.readHelpers()).rows[0];
  await fs.mkdir(join(dir, "helpers", row.id), { recursive: true });
  const path = join(dir, "helpers", row.id, "result");
  await fs.writeFile(path, "delivered result");
  const before = await fs.readFile(join(dir, "helpers.json"), "utf8");
  const original = fs.rename;
  t.mock.method(fs, "rename", (a: PathLike, b: PathLike) =>
    String(b).endsWith("helpers.json")
      ? Promise.reject(Error("disk rename failed"))
      : original(a, b),
  );
  syncBuiltinESMExports();
  for (const action of [
    () => s.addHelper({ task: "next", may: "", chat }, 4000),
    () => s.closeHelper(row.id, chat, 4000),
  ]) {
    await assert.rejects(action, /disk rename failed/);
    assert.equal(await fs.readFile(join(dir, "helpers.json"), "utf8"), before);
    assert.equal(await fs.readFile(path, "utf8"), "delivered result");
  }
});
