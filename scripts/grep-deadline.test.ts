import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ToolContext } from "eve/tools";
const { default: grep } = await import("../agent/tools/grep.ts");
for (const mode of ["deadline", "abort"]) {
  await test(`grep hears ${mode} while a hostile expression runs`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "iva-grep-deadline-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "hostile.txt");
    writeFileSync(path, "a".repeat(40) + "!");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["scripts/fixtures/grep-deadline.ts", path, mode],
      { timeout: 4000 },
    );
    const output = JSON.parse(stdout) as {
      result: { error: string };
      ticks: number;
    };
    assert.ok(output.ticks > 0, "event loop blocked");
    assert.match(
      output.result.error,
      mode === "deadline" ? /выражение слишком тяжёлое, упрости/u : /отмен/u,
    );
  });
}
await test("grep returns model text for malformed patterns and flags", async () => {
  for (const input of [{ pattern: "[" }, { pattern: "hello", flags: "bad" }]) {
    const output = await grep.execute(
      { ...input, path: import.meta.filename },
      { abortSignal: new AbortController().signal } as ToolContext,
    );
    assert.ok(
      typeof output === "object" && output !== null && "error" in output,
    );
  }
});
