/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registrations. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashEveTree } from "./lib/eve-tree-hash.ts";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
const TOOL = String.raw`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {appendFileSync, copyFileSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename} from 'node:path';
const tool = basename(process.argv[1]), args = process.argv.slice(2);
const step = tool === 'git' ? args[0] === 'rev-parse' ? 'commit' : args[0] === 'tag' ? 'tag' : args[0] === 'push' ? 'push' : null : tool === 'gh' ? args[1] : tool === 'curl' ? 'download' : 'ci';
if (step) {
 appendFileSync(process.env.EVE_TEST_LOG, step+' '+args.join(' ')+'\n');
 if (process.env.EVE_TEST_FAIL === step) process.exit(7);
}
if (tool === 'git') {
 if (args[0] === 'push') { if (args.join(' ') !== 'push origin refs/tags/eve-0.51.1-iva.1') throw Error('unexpected push'); process.exit(0); }
 const result = spawnSync(process.env.EVE_TEST_GIT, args, {stdio: 'inherit'}); process.exit(result.status ?? 1);
}
if (tool === 'curl') {
 const dest = args[args.indexOf('--output')+1];
 if (process.env.EVE_TEST_FAIL === 'sri') writeFileSync(dest, 'wrong bytes');
 else copyFileSync(process.env.EVE_TEST_ARCHIVE, dest);
}
if (tool === 'npm') {
 if (args[0] !== 'ci' || !process.cwd().endsWith('/ci')) throw Error('not clean ci');
 const cache = args[args.indexOf('--cache')+1];
 if (readdirSync(cache).length) throw Error('cache not empty');
 const lock = JSON.parse(readFileSync('package-lock.json','utf8'));
 if (!lock.packages['node_modules/eve'].resolved.startsWith('https://github.com/')) throw Error('not final URL');
}
`;
const STEPS = ["commit", "tag", "push", "create", "upload", "download", "ci"];
for (const failure of ["none", ...STEPS, "sri"]) {
  test(`publication runs in order and stops at ${failure}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "eve-publish-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ["scripts/lib", "eve", "out/input/package", "tools"])
      mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of [
      "scripts/eve-release.sh",
      "scripts/lib/eve-tree-hash.ts",
    ])
      copyFileSync(path.join(ROOT, file), path.join(root, file));
    const json = (file: string, value: unknown) =>
      writeFileSync(path.join(root, file), JSON.stringify(value));
    json("package.json", { dependencies: { eve: "0.51.1" } });
    json("package-lock.json", {
      packages: {
        "": { dependencies: { eve: "0.51.1" } },
        "node_modules/eve": { version: "0.51.1" },
      },
    });
    writeFileSync(path.join(root, "eve/NOTICE"), "source");
    json("out/input/package/package.json", {
      name: "eve",
      version: "0.51.1-iva.1",
    });
    const sourceTreeHash = await hashEveTree(path.join(root, "eve"), "source"),
      packedTreeHash = await hashEveTree(
        path.join(root, "out/input/package"),
        "packed",
      );
    json("out/input/package/BUILD.json", {
      packageVersion: "0.51.1-iva.1",
      sourceTreeHash,
      packedTreeHash,
    });
    const archive = path.join(root, "out/eve-0.51.1-iva.1.tgz");
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      path.join(root, "out/input"),
      "package",
    ]);
    writeFileSync(path.join(root, ".gitignore"), "out/\ntools/\ncalls.log\n");
    const git = (...args: string[]) => execFileSync(GIT, args, { cwd: root });
    git("init", "--quiet");
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=iva",
        "-c",
        "user.email=iva@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "source",
      );
    };
    commit();
    execFileSync("bash", ["scripts/eve-release.sh", "out"], { cwd: root });
    commit();
    for (const tool of ["git", "gh", "curl", "npm"]) {
      writeFileSync(path.join(root, "tools", tool), TOOL);
      chmodSync(path.join(root, "tools", tool), 0o755);
    }
    const log = path.join(root, "calls.log");
    const result = spawnSync(
      "bash",
      ["scripts/eve-release.sh", "--publish", "out"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(root, "tools")}:${process.env.PATH ?? ""}`,
          EVE_TEST_LOG: log,
          EVE_TEST_GIT: GIT,
          EVE_TEST_FAIL: failure,
          EVE_TEST_ARCHIVE: archive,
        },
      },
    );
    if (failure === "none")
      assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    if (calls.some((call) => call.startsWith("create ")))
      assert.ok(
        calls.includes(
          "create release create eve-0.51.1-iva.1 --repo smixs/iva-agent --verify-tag --latest=false --title eve-0.51.1-iva.1 --notes eve source archive for Iva.",
        ),
      );
    if (calls.some((call) => call.startsWith("upload ")))
      assert.ok(
        calls.includes(
          `upload release upload eve-0.51.1-iva.1 ${archive} --repo smixs/iva-agent`,
        ),
      );
    const expected =
      failure === "none"
        ? STEPS
        : STEPS.slice(
            0,
            STEPS.indexOf(failure === "sri" ? "download" : failure) + 1,
          );
    assert.deepEqual(
      calls.map((call) => call.split(" ")[0]),
      expected,
    );
    assert.equal(
      calls
        .filter((call) => call.startsWith("push "))
        .every(
          (call) => call === "push push origin refs/tags/eve-0.51.1-iva.1",
        ),
      true,
    );
    assert.equal(
      result.stdout.includes("Можно пушить beta"),
      failure === "none",
    );
    assert.equal(
      execFileSync(GIT, ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
      "",
    );
  });
}
