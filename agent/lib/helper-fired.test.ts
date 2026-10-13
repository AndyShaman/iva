/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { assistantBearerAuth } from "./eve-auth.ts";
const request = (v?: string) =>
  new Request("http://fixture.invalid", {
    headers: {
      authorization: "Bearer fixture",
      "x-iva-turn": "helper",
      "x-iva-helper": "h-abc123",
      ...(v === undefined ? {} : { "x-iva-helper-fired": v }),
    },
  });
test("numeric fired marker is a validated scalar; absent is diagnostic", async () => {
  const auth = assistantBearerAuth("fixture");
  assert.equal(
    (await auth(request("1000")))?.attributes?.iva_helper_fired,
    "1000",
  );
  assert.equal(
    (await auth(request()))?.attributes?.iva_helper_fired,
    undefined,
  );
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.constantFrom(
          "",
          "-1",
          "1.5",
          "1e3",
          "9007199254740992",
          "NaN",
          "1 0",
        ),
        fc.string().filter((s) => !/^\d+$/.test(s.trim()) && !/[\r\n]/.test(s)),
      ),
      async (s) => {
        await assert.rejects(Promise.resolve().then(() => auth(request(s))));
      },
    ),
    { seed: 20261013, numRuns: 60 },
  );
});
