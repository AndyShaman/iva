import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lockCommand } from "#lib/lock-command.ts";
import type { LaunchConfig } from "./launchd-run.ts";
import { underMemoryLock } from "./memory-lock.ts";

const launcher = join(import.meta.dirname, "launchd-run.ts");

void test(
  "native memory lock reports open failures separately from contention",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "iva-lockf-error-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const messages: string[] = [];
    t.mock.method(console, "error", (message: string) =>
      messages.push(message),
    );
    const env = { ...process.env };
    delete env.IVA_MEMORY_LOCK_HELD;
    assert.equal(underMemoryLock(join(dir, "missing/lock"), env, "darwin"), 73);
    assert.match(messages.join("\n"), /cannot take .*cannot open/u);
    assert.doesNotMatch(messages.join("\n"), /held by a running memory job/u);
    const denied = join(dir, "denied");
    mkdirSync(denied);
    chmodSync(denied, 0);
    try {
      assert.equal(underMemoryLock(join(denied, "lock"), env, "darwin"), 73);
      assert.match(messages.at(-1) ?? "", /cannot take .*Permission denied/u);
    } finally {
      chmodSync(denied, 0o700);
    }
    const lock = join(dir, "busy.lock");
    const ready = join(dir, "ready");
    const holder = spawn(
      "/usr/bin/lockf",
      [
        "-t",
        "0",
        lock,
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(ready)},'');setInterval(()=>{},1000)`,
      ],
      { detached: true, stdio: "ignore" },
    );
    const closed = new Promise((resolve) => holder.once("exit", resolve));
    try {
      const end = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(ready));
      const probe = spawnSync("/usr/bin/lockf", [
        "-t",
        "0",
        lock,
        "/usr/bin/true",
      ]);
      assert.equal(probe.status, 75);
      assert.equal(underMemoryLock(lock, env, "darwin"), 1);
      assert.equal(
        messages.at(-1),
        `${lock} is held by a running memory job — try again after it ends`,
      );
    } finally {
      if (holder.pid && holder.exitCode === null)
        process.kill(-holder.pid, "SIGKILL");
      await closed;
    }
  },
);

void test("lock command preserves Linux argv and uses native lockf on Darwin", () => {
  assert.deepEqual(lockCommand({ file: "/x", waitSeconds: 3900 }, "linux"), {
    command: "flock",
    args: ["-w", "3900", "/x"],
  });
  assert.deepEqual(lockCommand({ file: "/x", nonBlocking: true }, "linux"), {
    command: "flock",
    args: ["-n", "-E", "75", "/x"],
  });
  assert.deepEqual(
    lockCommand({ file: "/x", waitSeconds: 2, command: "/bin/flock" }, "linux"),
    { command: "/bin/flock", args: ["-w", "2", "/x"] },
  );
  assert.deepEqual(lockCommand({ file: "/x", waitSeconds: 3900 }, "darwin"), {
    command: "/usr/bin/lockf",
    args: ["-t", "3900", "/x"],
  });
  assert.deepEqual(lockCommand({ file: "/x", nonBlocking: true }, "darwin"), {
    command: "/usr/bin/lockf",
    args: ["-t", "0", "/x"],
  });
});

void test("launcher runs pre/main/post, ignores only marked failures and refuses a missing env file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launcher-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "order");
  const envFile = join(dir, ".env");
  writeFileSync(envFile, "");
  const js = (source: string): string[] => [process.execPath, "-e", source];
  const config: LaunchConfig = {
    envFile,
    pre: [
      { ignore: true, args: ["/usr/bin/false"] },
      {
        ignore: false,
        args: js(
          `require('fs').writeFileSync(${JSON.stringify(marker)},'pre')`,
        ),
      },
    ],
    post: [
      {
        ignore: false,
        args: js(
          `require('fs').appendFileSync(${JSON.stringify(marker)},'post')`,
        ),
      },
    ],
  };
  const run = (settings: LaunchConfig, main: string[]) =>
    spawnSync(process.execPath, [launcher, JSON.stringify(settings), ...main], {
      encoding: "utf8",
      timeout: 15_000,
    });
  const main = js(
    `if(!require('fs').existsSync(${JSON.stringify(marker)}))process.exit(9);process.exit(7)`,
  );
  const result = run(config, main);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "prepost");
  const strict = run({ pre: [{ ignore: false, args: ["/usr/bin/false"] }] }, [
    "/usr/bin/true",
  ]);
  assert.equal(strict.status, 1);
  const missing = run({ envFile: join(dir, "absent") }, ["/usr/bin/true"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /нет .*absent/u);
});

void test("launcher forwards SIGTERM and returns the signal exit code", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-launcher-signal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready");
  const child = spawn(
    process.execPath,
    [
      launcher,
      "{}",
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
    ],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const end = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(ready));
  child.kill("SIGTERM");
  assert.equal(await closed, 143);
});

void test(
  "oneshot deadline kills an uncooperative grandchild and releases the native memory lock",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "iva-launcher-deadline-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock = join(dir, "memory.lock");
    const script = join(dir, "stubborn.ts");
    writeFileSync(
      script,
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        JSON.stringify({ timeoutSeconds: 0.3 }),
        "/usr/bin/lockf",
        "-t",
        "0",
        lock,
        process.execPath,
        script,
      ],
      { encoding: "utf8", timeout: 17_000 },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    const probe = spawnSync(
      "/usr/bin/lockf",
      ["-t", "0", lock, "/usr/bin/true"],
      { encoding: "utf8", timeout: 2000 },
    );
    assert.equal(probe.status, 0, probe.stderr);
  },
);
