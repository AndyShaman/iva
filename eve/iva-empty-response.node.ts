// Run with Node against a built eve archive installed in an isolated Iva tree.
// Exercises Iva's authored instructions/tools and its real event readers.
import "../scripts/fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { wireTurn } from "../scripts/fixtures/helper-turn.test-fixture.ts";
import { reduceTurnEvents } from "../scripts/lib/reminder-turn.ts";
import { foldHelperSnapshot } from "../agent/lib/helper-snapshot.ts";
const home = await mkdtemp(join(tmpdir(), "iva-empty-response-"));
process.env.ASSISTANT_DATA_DIR = join(home, "data");
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.MODEL_PROVIDER = "ollama";
process.env.AGENT_LANGUAGE = "ru";
await mkdir(process.env.ASSISTANT_VAULT_DIR, { recursive: true });
await writeFile(
  join(process.env.ASSISTANT_VAULT_DIR, "CORE.md"),
  "Fixture owner",
);
after(() => rm(home, { recursive: true, force: true }));
const notice =
  "Модель не дала ответа после нескольких попыток. Попробуйте ещё раз.";
for (const mode of ["conversation", "task"] as const) {
  for (const kind of [
    "chat",
    "reminder",
    "watch",
    "brief",
    "insight",
    "signal",
    "helper",
  ]) {
    for (const emptyN of [1, 2, 3, Number.POSITIVE_INFINITY]) {
      test(`${kind}/${mode}: ${emptyN} empty responses`, async () => {
        const turn = await wireTurn({ mode, kind, emptyN });
        assert.equal(
          turn.model.doStreamCalls.length + turn.model.doGenerateCalls.length,
          Math.min(emptyN + 1, 4),
        );
        const exhausted = emptyN === Number.POSITIVE_INFINITY;
        const expectedFailure = exhausted && mode === "conversation";
        assert.equal(
          turn.events.some((event) => event.type === "turn.failed"),
          expectedFailure,
        );
        if (!expectedFailure) {
          const expectedText = exhausted ? notice : "done";
          assert.ok(
            turn.events.some((event) => event.type === "turn.completed"),
          );
          assert.equal(
            turn.events.some((event) => event.type.endsWith(".failed")),
            false,
          );
          assert.equal(reduceTurnEvents(turn.events).message, expectedText);
          const helper = foldHelperSnapshot(turn.events);
          assert.equal(helper.text, expectedText);
          assert.equal(helper.outcome, "done");
          if (mode === "task")
            assert.deepEqual(turn.result.next, {
              done: true,
              output: expectedText,
            });
        }
      });
    }
  }
}
for (const guarded of ["schema", "step ceiling"]) {
  test(`always-empty task preserves ${guarded}`, async () => {
    const turn = await wireTurn({
      mode: "task",
      emptyN: Number.POSITIVE_INFINITY,
      ...(guarded === "schema"
        ? {
            outputSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          }
        : { attributes: { iva_max_steps: "1" } }),
    });
    assert.ok(turn.events.some((event) => event.type === "turn.failed"));
    assert.ok(
      turn.result.next &&
        "isError" in turn.result.next &&
        turn.result.next.isError,
    );
  });
}
