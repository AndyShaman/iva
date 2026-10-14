/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { isQuietReply as originalQuiet } from "../../scripts/lib/reminder-turn.ts";
const seed = Number(process.env.FC_SEED ?? 20261014);
test(`v7 snapshot fold: first terminal, last string, exact usage and model; seed ${seed}`, async () => {
  const { foldHelperSnapshot } = await import("./helper-snapshot.ts");
  const terminal = {
    "turn.completed": "done",
    "session.completed": "done",
    "turn.failed": "failed",
    "session.failed": "failed",
    "input.requested": "failed",
    "authorization.required": "failed",
    "turn.cancelled": "interrupted",
  } as const;
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            kind: fc.constant("text"),
            value: fc.option(fc.string(), { nil: null }),
          }),
          fc.record({
            kind: fc.constant("usage"),
            input: fc.nat(1000),
            output: fc.nat(100),
            model: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          }),
          fc.record({
            kind: fc.constant("start"),
            value: fc.string({ minLength: 1 }),
          }),
          fc.record({
            kind: fc.constant("end"),
            value: fc.constantFrom(...Object.keys(terminal)),
          }),
          fc.record({ kind: fc.constant("delta"), value: fc.string() }),
        ),
        { maxLength: 40 },
      ),
      (records) => {
        const events = records.map((r) =>
          r.kind === "text"
            ? { type: "message.completed", data: { message: r.value } }
            : r.kind === "usage"
              ? {
                  type: "step.completed",
                  data: {
                    usage: { inputTokens: r.input, outputTokens: r.output },
                    providerModelId: r.model,
                  },
                }
              : r.kind === "start"
                ? { type: "step.started", data: { modelId: r.value } }
                : r.kind === "end"
                  ? { type: r.value, data: { message: "failure cause" } }
                  : {
                      type: "message.appended",
                      data: { messageDelta: r.value },
                    },
        );
        const texts = records.filter((r) => r.kind === "text");
        const expectedText =
          texts.filter((r) => typeof r.value === "string").at(-1)?.value ??
          null;
        const usage = records.filter((r) => r.kind === "usage");
        const inputs = usage.map((r) => r.input),
          outputs = usage.map((r) => r.output);
        const work =
          outputs.reduce((a, b) => a + b, 0) +
          inputs.reduce(
            (sum, n, i) => sum + Math.max(0, n - (inputs[i - 1] ?? 0)),
            0,
          );
        const first = records.find((r) => r.kind === "end");
        const expectedModel =
          usage.at(-1)?.model ??
          records.filter((r) => r.kind === "start").at(-1)?.value ??
          null;
        const actual = foldHelperSnapshot(events);
        assert.equal(actual.text, expectedText);
        assert.equal(actual.steps, usage.length);
        assert.equal(actual.tokens, work);
        assert.equal(actual.model, expectedModel);
        assert.equal(actual.ended, !!first);
        const expected = first
          ? terminal[first.value as keyof typeof terminal]
          : "empty";
        assert.equal(
          actual.outcome,
          expected === "done" &&
            (!expectedText?.trim() || originalQuiet(expectedText))
            ? "empty"
            : expected,
        );
      },
    ),
    { seed, numRuns: 500 },
  );
});
test(`v7 quiet check equals the original for Unicode and decorated QUIET; summary bounds; seed ${seed}`, async () => {
  const { isQuietReply, helperSummary, foldHelperSnapshot } =
    await import("./helper-snapshot.ts");
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ maxLength: 3000 }),
        fc.string().map((s) => `${s}QUIET${s}`),
        fc.constantFrom(" QUIET ", "**quiet**", "\u200B«QUIET».", "quiet work"),
      ),
      (text) => {
        assert.equal(isQuietReply(text), originalQuiet(text));
        const summary = helperSummary(text);
        assert.ok(summary === null || summary.length <= 1500);
        if (text.trim().length > 1500) assert.ok(summary?.endsWith("…"));
      },
    ),
    { seed, numRuns: 500 },
  );
  assert.equal(helperSummary("x\n\n" + "😀".repeat(1500))?.endsWith("…"), true);
  const f = foldHelperSnapshot([
    { type: "turn.completed", data: { reason: "step-limit" } },
  ]);
  assert.equal(f.outcome, "ceiling");
  assert.equal(
    foldHelperSnapshot([{ type: "authorization.required" }]).reason,
    "помощник ждал авторизации",
  );
  assert.equal(
    foldHelperSnapshot([{ type: "input.requested" }]).reason,
    "помощник ждал ответа",
  );
});
