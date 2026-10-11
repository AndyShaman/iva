/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashEveTree, listEveTreeFiles } from "./lib/eve-tree-hash.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_ROOT = path.join(ROOT, "eve");
const INSTALLED_ROOT = path.join(ROOT, "node_modules/eve");

interface EveBuildMetadata {
  readonly nodeVersion: string;
  readonly packageVersion: string;
  readonly packedTreeHash: string;
  readonly pnpmVersion: string;
  readonly sourceTreeHash: string;
  readonly upstreamCommit: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

test("eve source files match the git index", async () => {
  const files = new Set(await listEveTreeFiles(SOURCE_ROOT, "source"));
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z", "--", "eve"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((file) => file.slice("eve/".length)),
  );
  assert.deepEqual(
    {
      missing: [...tracked].filter((file) => !files.has(file)),
      untracked: [...files].filter((file) => !tracked.has(file)),
    },
    { missing: [], untracked: [] },
    "eve source files differ from git index",
  );
});

test("installed eve is the package built from the current eve source tree", async () => {
  const build = await readJson<EveBuildMetadata>(
    path.join(INSTALLED_ROOT, "BUILD.json"),
  );
  const packageJson = await readJson<{ readonly version: string }>(
    path.join(INSTALLED_ROOT, "package.json"),
  );
  const [sourceTreeHash, packedTreeHash] = await Promise.all([
    hashEveTree(SOURCE_ROOT, "source"),
    hashEveTree(INSTALLED_ROOT, "packed"),
  ]);

  assert.equal(
    sourceTreeHash,
    build.sourceTreeHash,
    "eve/ differs from the built source tree",
  );
  assert.equal(
    packedTreeHash,
    build.packedTreeHash,
    "node_modules/eve package was changed",
  );
  assert.equal(
    packageJson.version,
    build.packageVersion,
    "installed eve version differs from BUILD.json",
  );
  assert.match(build.upstreamCommit, /^[0-9a-f]{40}$/u);
  assert.match(build.pnpmVersion, /^11\.25\.0$/u);
  assert.match(build.nodeVersion, /^v\d+\./u);
});

// Wave 2 activates package-lock.json version, resolved URL, and integrity assertions
// when the eve dependency moves from npm plus patch-package to the immutable archive.

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  return env;
}

function hooksPath(root: string): string {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get", "core.hooksPath"],
    {
      cwd: root,
      env: gitEnvironment(),
      encoding: "utf8",
    },
  );
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout;
}

const PNPM_FIXTURE = String.raw`#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("11.25.0"); process.exit(0); }
const stage = args[0] === "install" ? "install" : args.includes("build") ? "build" : "pack";
const root = path.dirname(process.cwd());
const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
assert.notEqual(probe.status, 0, stage + " discovered the parent repository");
execFileSync(process.execPath, ["scripts/install-git-hooks.mjs"]);
appendFileSync(path.join(root, "stages.txt"), stage + "\n");
if (stage === "pack") {
  const source = path.join(process.cwd(), "packages/eve");
  const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const destination = args[args.indexOf("--pack-destination") + 1];
  const input = path.join(root, "pack-input");
  rmSync(input, { recursive: true, force: true });
  mkdirSync(input);
  cpSync(source, path.join(input, "package"), { recursive: true });
  execFileSync("tar", ["-czf", path.join(destination, "eve-" + version + ".tgz"), "-C", input, "package"]);
}
`;

for (const inheritedGitDirectory of [false, true]) {
  test(`eve build preserves Git hooks at every step (inherited Git directory: ${inheritedGitDirectory})`, async () => {
    const before = hooksPath(ROOT);
    const fixture = await mkdtemp(path.join(tmpdir(), "eve-build-hooks-"));
    try {
      execFileSync("git", ["init", "--quiet", fixture], {
        env: gitEnvironment(),
      });
      for (const directory of [
        "scripts/lib",
        "eve/scripts",
        "eve/packages/eve",
      ])
        await mkdir(path.join(fixture, directory), { recursive: true });
      for (const file of [
        "scripts/build-eve.sh",
        "scripts/lib/eve-tree-hash.ts",
        "eve/scripts/install-git-hooks.mjs",
        "eve/scripts/copy-package-license.mjs",
        "eve/LICENSE",
        "eve/NOTICE",
      ])
        await copyFile(path.join(ROOT, file), path.join(fixture, file));
      const packageRoot = path.join(fixture, "eve/packages/eve");
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "eve",
          version: "0.51.1",
          license: "Apache-2.0",
          files: [],
        }),
      );
      const pnpm = path.join(fixture, "pnpm.ts");
      await writeFile(pnpm, PNPM_FIXTURE);
      await chmod(pnpm, 0o755);
      const env: NodeJS.ProcessEnv = {
        ...gitEnvironment(),
        EVE_PNPM_BIN: pnpm,
      };
      if (inheritedGitDirectory) {
        env.GIT_DIR = path.join(fixture, ".git");
        env.GIT_WORK_TREE = fixture;
        env.GIT_COMMON_DIR = env.GIT_DIR;
        env.GIT_INDEX_FILE = path.join(env.GIT_DIR, "index");
      }
      execFileSync(
        "bash",
        [path.join(fixture, "scripts/build-eve.sh"), path.join(fixture, "out")],
        { env },
      );
      assert.equal(
        await readFile(path.join(fixture, "stages.txt"), "utf8"),
        "install\nbuild\npack\npack\n",
      );
      assert.equal(hooksPath(fixture), "");
      assert.equal(hooksPath(ROOT), before);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
