/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isEmptyModelResponse } from "./model-response.ts";
const seed = Number(process.env.FC_SEED ?? 20261020);
test(`empty response uses the semantic id independently of prose; seed ${seed}`, () => {
  fc.assert(
    fc.property(fc.string(), (message) => {
      assert.equal(
        isEmptyModelResponse({
          message,
          details: { semanticErrorId: "empty-model-response" },
        }),
        true,
      );
      assert.equal(isEmptyModelResponse({ message }), false);
    }),
    { seed, numRuns: 100 },
  );
});
for (const message of [
  "EmptyModelResponseError",
  "The model did not return a response",
  "provider down",
])
  test(`prose alone is not a semantic failure marker: ${message}`, () => {
    assert.equal(isEmptyModelResponse({ message }), false);
  });
