/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isEmptyModelResponse } from "./model-response.ts";

const seed = Number(process.env.FC_SEED ?? 20261020);
test(`empty response failure is recognized inside public error wrappers; seed ${seed}`, () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.constantFrom(
        "EmptyModelResponseError",
        "The model did not return a response",
      ),
      fc.string(),
      (prefix, cause, suffix) =>
        assert.equal(isEmptyModelResponse(prefix + cause + suffix), true),
    ),
    { seed, numRuns: 100 },
  );
});

for (const cause of [
  undefined,
  "",
  "provider down",
  "session token limit",
  "cancelled",
])
  test(`other failures retain their existing handling: ${cause}`, () => {
    assert.equal(isEmptyModelResponse(cause), false);
  });
