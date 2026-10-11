/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVersionStore } from "./lib/version-store.ts";
import {
  eveArchive,
  runChild,
  type ArchiveFault,
} from "./fixtures/eve-archive.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: "iva",
  GIT_AUTHOR_EMAIL: "iva@example.invalid",
  GIT_COMMITTER_NAME: "iva",
  GIT_COMMITTER_EMAIL: "iva@example.invalid",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}
function write(root: string, file: string, value: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), value);
}
// The shipped CLI shim and its real dispatcher run against fixture paths. Only import
// locations change: source modules remain in this checkout, with its installed dependencies.
const CLI = readFileSync(join(ROOT, "bin/iva.mjs"), "utf8")
  .replace(
    '"../scripts/cli/main.ts"',
    JSON.stringify(pathToFileURL(join(ROOT, "scripts/cli/main.ts")).href),
  )
  .replace(
    '"../scripts/lib/version-layout.ts"',
    JSON.stringify(
      pathToFileURL(join(ROOT, "scripts/lib/version-layout.ts")).href,
    ),
  );
const FINISH = `import { main } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/update-finish.ts")).href)};
process.exitCode = await main(process.argv.slice(2));\n`;

for (const layout of ["current", "lost-current", "legacy"] as const) {
  for (const fault of [
    "ok",
    "404",
    "drop",
    "integrity",
    "truncated",
  ] satisfies ArchiveFault[]) {
    test(`archive npm ci through ${layout === "legacy" ? "repair.sh" : "iva update"} (${layout}, ${fault}) preserves old code before activation`, async (t) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "iva-eve-archive-update-")),
      );
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, "iva"),
        source = join(root, "source"),
        remote = join(root, "remote.git"),
        tools = join(root, "tools"),
        log = join(root, "npm.log");
      const archive = await eveArchive(t, root);
      archive.setFault(fault);
      write(
        source,
        "package.json",
        JSON.stringify({
          name: "iva",
          version: layout === "legacy" ? "0.4.8" : "0.4.16",
          type: "module",
        }),
      );
      write(source, "bin/iva.mjs", CLI);
      write(source, "scripts/update-finish.ts", FINISH);
      write(source, ".gitignore", ".env\ndata/\n.output/\nnode_modules/\n");
      git(source, "init", "--quiet", "--initial-branch=main");
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "old installation");
      const oldSha = git(source, "rev-parse", "HEAD");
      const oldName = `0.4.16-${oldSha.slice(0, 12)}`;
      archive.writeManifest(source);
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "new archive dependency");
      git(source, "tag", "v0.4.17");
      git(root, "clone", "--quiet", "--bare", source, remote);
      mkdirSync(home, { recursive: true });
      write(home, ".env", "MODEL_PROVIDER=ollama\nAGENT_LANGUAGE=en\n");
      write(home, "data/sentinel", "user data\n");
      let oldRoot: string;
      if (layout === "legacy") {
        git(home, "init", "--quiet", "--initial-branch=main");
        git(home, "remote", "add", "origin", remote);
        git(home, "fetch", "--quiet", "origin", "main");
        git(home, "reset", "--quiet", "--hard", oldSha);
        oldRoot = home;
      } else {
        git(root, "clone", "--quiet", "--mirror", remote, join(home, "repo"));
        const store = createVersionStore(home);
        const name = oldName;
        oldRoot = store.stage(name);
        write(
          oldRoot,
          "package.json",
          '{"name":"iva","version":"0.4.16","type":"module"}',
        );
        write(oldRoot, "bin/iva.mjs", CLI);
        store.linkState(oldRoot);
        store.complete(name);
        store.activate(name);
        store.settle(name);
        if (layout === "lost-current") rmSync(join(home, "current"));
      }
      write(oldRoot, ".output/marker", "old serving code\n");
      write(
        oldRoot,
        "node_modules/eve/package.json",
        '{"name":"eve","version":"0.51.1"}',
      );
      mkdirSync(tools);
      symlinkSync(process.execPath, join(tools, "node"));
      // Even an unexpected service call is contained in this hermetic world.
      write(tools, "systemctl", "#!/bin/sh\nexit 0\n");
      chmodSync(join(tools, "systemctl"), 0o755);
      const env = {
        ...process.env,
        ...IDENTITY,
        HOME: root,
        PATH: `${tools}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: home,
        IVA_TEST_NPM_LOG: log,
        NO_COLOR: "1",
        TERM: "dumb",
      };
      for (const key of Object.keys(env))
        if (
          /^(?:npm_config_|NPM_CONFIG_|ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(key)
        )
          delete (env as NodeJS.ProcessEnv)[key];
      const run = () =>
        layout === "legacy"
          ? runChild("bash", [join(ROOT, "repair.sh")], env, root)
          : runChild(
              process.execPath,
              [join(oldRoot, "bin/iva.mjs"), "update"],
              env,
              root,
            );
      const result = await run();
      const npmLogs = readdirSync(join(root, "npm-cache/_logs"))
        .filter((file) => file.endsWith(".log"))
        .map((file) =>
          readFileSync(join(root, "npm-cache/_logs", file), "utf8"),
        )
        .join("\n");
      assert.match(
        npmLogs,
        /verbose argv "ci" "--no-audit" "--no-fund"/u,
        result.output,
      );
      assert.match(
        npmLogs,
        /cwd .*\/versions\/0\.4\.17-[a-f0-9]{12}/u,
        result.output,
      );
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      assert.ok(archive.requests.includes("/asset.tgz"), result.output);
      assert.equal(result.code, 1, result.output);
      assert.equal(calls.includes("CI_OK"), fault === "ok", result.output);
      assert.match(
        result.output,
        fault === "ok"
          ? /EVE_TEST_STOP_AFTER_CI/u
          : fault === "404"
            ? /E404/u
            : fault === "integrity"
              ? /EINTEGRITY/u
              : /ECONNRESET|ETIMEDOUT|EIDLETIMEOUT|ERR_SOCKET_TIMEOUT/u,
      );
      const checkOld = () => {
        assert.equal(
          readFileSync(join(oldRoot, ".output/marker"), "utf8"),
          "old serving code\n",
        );
        assert.equal(
          (
            JSON.parse(
              readFileSync(
                join(oldRoot, "node_modules/eve/package.json"),
                "utf8",
              ),
            ) as { version: string }
          ).version,
          "0.51.1",
        );
        assert.equal(
          readFileSync(join(home, "data/sentinel"), "utf8"),
          "user data\n",
        );
        assert.equal(
          createVersionStore(home).currentName(),
          layout === "legacy" ? null : oldName,
        );
      };
      checkOld();
      if (fault === "truncated") {
        archive.setFault("ok");
        const retry = await run();
        assert.match(readFileSync(log, "utf8"), /CI_OK/u, retry.output);
        assert.match(retry.output, /EVE_TEST_STOP_AFTER_CI/u);
        checkOld();
      }
      assert.ok(
        archive.requests.every((url) =>
          ["/eve.tgz", "/asset.tgz"].includes(url),
        ),
        archive.requests.join("\n"),
      );
    });
  }
}
