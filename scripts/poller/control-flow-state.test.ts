/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
// Дешёвый CRAP-тест предиката визарда: мусор и частично валидные объекты — false,
// полное валидное состояние — true. Seed в имени; при провале подставь path.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isTelegramFlowState } from "./control.ts";

const SEED = 20_260_913;

const valid = (): { flow: string } & Record<string, unknown> => ({
  flow: "model",
  chatId: 7,
  userId: "42",
  createdAt: 1_700_000_000_000,
  msgId: null,
  provider: "ollama",
  modelOptions: [],
  model: "x",
  efforts: [],
  effort: null,
  step: "intro",
  awaitText: null,
  screen: null,
  page: 0,
  data: {},
});

test("isTelegramFlowState: валидное состояние проходит (seed 20260913)", () => {
  assert.equal(isTelegramFlowState(valid()), true);
  assert.equal(
    isTelegramFlowState({ ...valid(), chatId: "7", userId: 42, msgId: 11 }),
    true,
    "id строкой/числом и живой msgId — тоже валидны",
  );
});

test("isTelegramFlowState: мусор и недозаполненное — false (seed 20260913)", () => {
  fc.assert(
    fc.property(
      fc.anything().filter((v) => v !== undefined && v !== null),
      fc.integer({ min: 0, max: 15 }),
      (junk, drop) => {
        const shaped = (
          junk !== null && typeof junk === "object" && !Array.isArray(junk)
            ? { ...valid(), ...junk }
            : junk
        ) as Record<string, unknown>;
        const keys = Object.keys(valid());
        const cut =
          shaped !== null &&
          typeof shaped === "object" &&
          !Array.isArray(shaped)
            ? Object.fromEntries(
                Object.entries(shaped).filter(
                  ([key]) =>
                    !keys.slice(0, drop % (keys.length + 1)).includes(key),
                ),
              )
            : shaped;
        // Полное совпадение с валидным пропускаем: это дело якоря выше.
        if (
          cut !== null &&
          typeof cut === "object" &&
          keys.every(
            (key) => (cut as Record<string, unknown>)[key] !== undefined,
          )
        )
          return;
        assert.equal(
          isTelegramFlowState(cut as never),
          false,
          `мусор прошёл предикат: ${JSON.stringify(cut)?.slice(0, 120)}`,
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});
