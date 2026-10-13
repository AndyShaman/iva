/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  eventCases,
  eventProbe,
} from "./fixtures/helper-events-r3.test-fixture.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
const base = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-events-base.json", import.meta.url),
    "utf8",
  ),
) as {
  base: string;
  archive: string;
  cases: Record<string, Awaited<ReturnType<typeof eventProbe>>>;
};
assert.equal(base.base, "21f447ed");
assert.equal(base.archive, "0.51.1-iva.1");
for (const mode of ["conversation", "task"] as const)
  for (const scenario of eventCases)
    test(`L3 unlimited ${mode}/${scenario} preserves base events and outcome`, async () => {
      assert.deepEqual(
        await eventProbe(mode, scenario),
        base.cases[`${mode}/${scenario}`],
      );
    });
