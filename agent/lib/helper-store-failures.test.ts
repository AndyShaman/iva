/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import crypto from "node:crypto";
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
test("T1 id collision 32 times preserves table and directories", async (t) => {
  const dir = await setup(t);
  let calls = 0;
  t.mock.method(crypto, "randomBytes", () => {
    calls++;
    return Buffer.from("ffffff", "hex");
  });
  syncBuiltinESMExports();
  const s = await import("./helper-store.ts");
  await fs.mkdir(join(dir, "helpers", "h-ffffff", "out"), { recursive: true });
  const before = await fs.readdir(join(dir, "helpers"));
  const r = await s.addHelper({ task: "task", may: "", chat }, 1000);
  assert.equal(r.ok, false);
  assert.equal(calls, 32);
  assert.deepEqual(await s.readHelpers(), {
    schemaVersion: 1,
    rows: [],
  });
  assert.deepEqual(await fs.readdir(join(dir, "helpers")), before);
  t.mock.restoreAll();
  syncBuiltinESMExports();
});
test("T1 failed rename rolls back only its new directory and preserves table bytes", async (t) => {
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
  assert.deepEqual(await fs.readdir(join(dir, "helpers")), []);
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
    });
  } finally {
    releaseLock(path, token);
  }
});
test("orphan cleanup waits for mkdir-to-row critical section", async (t) => {
  const dir = await setup(t);
  const s = await import("./helper-store.ts");
  const path = join(dir, "helpers.json.lock");
  const token = await acquireLock(path);
  await fs.mkdir(join(dir, "helpers", "h-aabbcc", "out"), { recursive: true });
  let ended = false;
  const cleaning = s.sweepHelpers(2000).then(() => {
    ended = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ended, false);
  const row = {
    id: "h-aabbcc",
    task: "task",
    may: "",
    chat,
    createdAt: 1000,
    status: "pending",
    run: null,
    stop: null,
    outcome: null,
    summary: null,
    reason: null,
    model: null,
    steps: 0,
    tokens: 0,
    finishedAt: null,
    delivered: null,
  };
  await fs.writeFile(
    join(dir, "helpers.json"),
    JSON.stringify({ schemaVersion: 1, rows: [row] }),
  );
  releaseLock(path, token);
  await cleaning;
  assert.ok((await fs.readdir(join(dir, "helpers"))).includes("h-aabbcc"));
});
