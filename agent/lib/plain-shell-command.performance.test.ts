/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

const MIB = 1024 * 1024;
const PIECES = [
  "|||",
  "&&&",
  "${X}",
  "$(iva restart)",
  "`pkill node`",
  "\\\n",
  "2>&1x",
  "printf -v",
  "sort --comp=x",
  "systemd-run --user true",
  "at now",
  "batch",
] as const;

function randomInput(bytes: number): string {
  const chunks = ["echo '"];
  let length = chunks[0]?.length ?? 0;
  let state = 287_041;
  while (length < bytes) {
    state = (state * 48_271) % 2_147_483_647;
    const piece = PIECES[state % PIECES.length] ?? "x";
    chunks.push(piece, " ");
    length += piece.length + 1;
  }
  chunks.push("'");
  return chunks.join("");
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function duration(input: string, parse: (value: string) => boolean): number {
  const started = performance.now();
  assert.equal(parse(input), true);
  return performance.now() - started;
}

test("разбор случайного мегабайта остаётся линейным", async () => {
  const { plainDataCommand } = await import("./plain-shell-command.ts");
  const one = randomInput(MIB);
  const two = randomInput(2 * MIB);
  plainDataCommand(randomInput(64 * 1024));
  const oneMs = median(
    Array.from({ length: 3 }, () => duration(one, plainDataCommand)),
  );
  const twoMs = median(
    Array.from({ length: 3 }, () => duration(two, plainDataCommand)),
  );
  const ratio = twoMs / Math.max(oneMs, 0.01);
  console.info(
    `L11 linearity: 1MiB=${oneMs.toFixed(2)}ms 2MiB=${twoMs.toFixed(2)}ms ratio=${ratio.toFixed(2)}`,
  );
  assert.ok(ratio <= 3.1, `отношение ${ratio.toFixed(2)} превышает 3.1`);
});
