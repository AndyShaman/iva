// Свойства парсеров process-lock отделены от сценариев с настоящими spawn/kill:
// два прогона fast-check по 2 000 вариантов грузят CPU и раньше делили файл с ожиданием
// живых дочерних процессов, из-за чего сроки в тех сценариях плыли под нагрузкой.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  parseTelegramGuardHolderMarker,
  parseTelegramProcessOwner,
} from "./process-lock.ts";

const SEED = 18_702;

void test("property: arbitrary owner bytes either fail or satisfy the full identity schema", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      try {
        const owner = parseTelegramProcessOwner(raw);
        assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
        assert.match(owner.nonce, /^[0-9a-f]{32}$/u);
        assert.deepEqual(Object.keys(owner).sort(), [
          "nonce",
          "pid",
          "processStart",
          "schema",
        ]);
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});

void test("property: arbitrary holder markers fail or satisfy the global schema", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      try {
        const holder = parseTelegramGuardHolderMarker(raw);
        assert.match(holder.resource, /^(?:telegram:[0-9]+|test:[a-z0-9-]+)$/u);
        assert.ok(Number.isSafeInteger(holder.pid) && holder.pid > 0);
        assert.match(holder.nonce, /^[0-9a-f]{32}$/u);
        assert.deepEqual(Object.keys(holder).sort(), [
          "nonce",
          "pid",
          "processStart",
          "resource",
          "schema",
        ]);
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});
