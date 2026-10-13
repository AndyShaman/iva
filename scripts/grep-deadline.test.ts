import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import fc from "fast-check";
import { Worker } from "node:worker_threads";
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

await test("grep stream preserves one-based lines and 300-character text (seed 101315)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-grep-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "lines.txt");
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.string({ maxLength: 450 }).filter((s) => !s.includes("\n")),
        { minLength: 1, maxLength: 20 },
      ),
      async (parts) => {
        const lines = ["no match", ...parts.map((s) => `needle ${s}`), ""];
        writeFileSync(path, lines.join("\n"));
        const answer = (await grep.execute(
          { path, pattern: "^needle", flags: "g" },
          { abortSignal: new AbortController().signal } as ToolContext,
        )) as {
          count: number;
          matches: { file: string; line: number; text: string }[];
        };
        assert.equal(answer.count, parts.length);
        assert.deepEqual(
          answer.matches,
          lines.slice(1, -1).map((text, index) => ({
            file: path,
            line: index + 2,
            text: text.length > 300 ? text.slice(0, 300) + "…" : text,
          })),
        );
      },
    ),
    { seed: 101315, numRuns: 30 },
  );
});

await test("grep deadline excludes message transfer before expression execution", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-grep-transfer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "line.txt");
  writeFileSync(path, "needle\n");
  const original: unknown = Reflect.get(Worker.prototype, "postMessage");
  assert.ok(typeof original === "function");
  const pending = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => {
    for (const timer of pending) clearTimeout(timer);
  });
  // Only the transport is delayed. The unmodified worker evaluates the actual expression.
  t.mock.method(
    Worker.prototype,
    "postMessage",
    function (this: Worker, value: unknown) {
      const timer = setTimeout(() => {
        pending.delete(timer);
        Reflect.apply(original, this, [value]);
      }, 1100);
      pending.add(timer);
    },
  );
  const answer = (await grep.execute({ path, pattern: "needle" }, {
    abortSignal: new AbortController().signal,
  } as ToolContext)) as { error?: string; count: number };
  assert.equal(answer.error, undefined);
  assert.equal(answer.count, 1);
});

await test("honest grep over 400 MiB reaches the same first 1000 matching lines", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-grep-large-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "large.txt");
  const marker = "ПРИВЕТ МИР\n";
  const line = "x".repeat(512 - Buffer.byteLength(marker)) + marker;
  const block = Buffer.from(line.repeat(2048));
  const handle = await open(path, "w");
  try {
    for (let i = 0; i < 400; i++) await handle.write(block);
  } finally {
    await handle.close();
  }
  const answer = (await grep.execute(
    { path, pattern: "ПРИВЕТ МИР$", flags: "iu" },
    { abortSignal: new AbortController().signal } as ToolContext,
  )) as {
    error?: string;
    count: number;
    truncated: boolean;
    matches: { file: string; line: number; text: string }[];
  };
  assert.equal(answer.error, undefined);
  assert.equal(answer.count, 1000);
  assert.equal(answer.truncated, true);
  assert.deepEqual(
    answer.matches,
    Array.from({ length: 1000 }, (_, i) => ({
      file: path,
      line: i + 1,
      text: "x".repeat(300) + "…",
    })),
  );
});
