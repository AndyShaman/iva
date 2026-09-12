/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства таблицы напоминаний на случайных входах. Якоря контракта — в reminder-store.test.ts,
// здесь генератор кормит нормализатор расписаний, claim и загрузку тем, что реально придёт из
// данных: произвольный JSON, случайные сроки, аренды и cron-выражения из мусорных полей.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import fc from "fast-check";
import type { Reminder } from "./reminder-store.ts";

const root = mkdtempSync(join(tmpdir(), "iva-reminders-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const {
  REMINDER_LEASE_MS,
  ReminderStoreError,
  add,
  claimDue,
  list,
  normalizeSchedule,
  reminderFile,
} = await import("./reminder-store.ts");
const { saveJsonAtomic } = await import("./json-store.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const FIELD = fc.string({
  unit: fc.constantFrom(
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "*",
    ",",
    "-",
    "/",
  ),
  minLength: 1,
  maxLength: 6,
});
const SEPARATOR = fc.constantFrom(" ", "  ", "\t", " \t ");
const PADDING = fc.string({
  unit: fc.constantFrom(" ", "\t"),
  maxLength: 3,
});

const scheduleArbitrary = fc.oneof(
  fc.record({
    kind: fc.constant("at" as const),
    atMs: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  }),
  fc
    .tuple(
      FIELD,
      FIELD,
      FIELD,
      FIELD,
      FIELD,
      SEPARATOR,
      SEPARATOR,
      SEPARATOR,
      SEPARATOR,
      fc.constantFrom(
        "UTC",
        "Asia/Tashkent",
        "Europe/Moscow",
        "America/New_York",
      ),
      PADDING,
      PADDING,
    )
    .map(([a, b, c, d, e, s1, s2, s3, s4, tz, head, tail]) => ({
      kind: "cron" as const,
      expr: `${head}${a}${s1}${b}${s2}${c}${s3}${d}${s4}${e}${tail}`,
      tz,
    })),
);

function rowAt(
  index: number,
  nextRunAtMs: number,
  leaseUntilMs: number | null,
): Reminder {
  return {
    id: `r${index}`,
    text: `напоминание ${index}`,
    mode: index % 2 === 0 ? "verbatim" : "judged",
    schedule: { kind: "at", atMs: nextRunAtMs },
    nextRunAtMs,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    deliver: { chatId: "42" },
    leaseUntilMs,
    deliveredKey: null,
  };
}

test("P1: нормализация расписания — roundtrip и идемпотентность", () => {
  fc.assert(
    fc.property(scheduleArbitrary, (input) => {
      const normalized = normalizeSchedule(input);

      assert.deepEqual(normalizeSchedule(normalized), normalized);
      assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);

      if (normalized.kind === "cron") {
        assert.deepEqual(Object.keys(normalized), ["kind", "expr", "tz"]);
        assert.equal(normalized.expr, normalized.expr.trim());
        const fields = normalized.expr.split(" ");
        assert.equal(fields.length, 5);
        for (const field of fields) assert.match(field, /^[0-9*,/-]+$/u);
      } else {
        assert.deepEqual(Object.keys(normalized), ["kind", "atMs"]);
      }
      return true;
    }),
    { numRuns: 200 },
  );
});

test("P2: claimDue не отдаёт будущее и не отдаёт занятое", async () => {
  // Сроки и аренды задаются смещением от now: масса на границе (0, ±1),
  // иначе точка, где расходятся <= и <, не попадает в выборку.
  const OFFSET = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: -3, max: 3 }) },
    {
      weight: 1,
      arbitrary: fc.integer({
        min: -2_000_000_000_000,
        max: 2_000_000_000_000,
      }),
    },
  );
  const shape = fc.array(
    fc.record({
      deadlineOffset: OFFSET,
      leaseUntilMs: fc.option(OFFSET, { nil: null }),
    }),
    { maxLength: 20 },
  );

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 2_000_000_000_000 }),
      fc.integer({ min: 1, max: 25 }),
      shape,
      async (now, limit, generated) => {
        const file = reminderFile();
        const rows = generated.map((g, index) =>
          rowAt(
            index,
            Math.max(0, now + g.deadlineOffset),
            g.leaseUntilMs === null ? null : Math.max(0, now + g.leaseUntilMs),
          ),
        );
        await saveJsonAtomic(file, { schemaVersion: 1, rows }, { mode: 0o600 });

        const claimed = await claimDue(now, limit);
        const eligible = rows.filter(
          (r) =>
            r.nextRunAtMs <= now &&
            (r.leaseUntilMs === null || r.leaseUntilMs <= now),
        );

        assert.equal(claimed.length, Math.min(limit, eligible.length));
        assert.equal(new Set(claimed.map((r) => r.id)).size, claimed.length);
        for (const reminder of claimed) {
          const source = rows.find((r) => r.id === reminder.id);
          assert.ok(source, "выдана строка не из файла");
          assert.ok(reminder.nextRunAtMs <= now, "выдана строка из будущего");
          assert.ok(
            source.leaseUntilMs === null || source.leaseUntilMs <= now,
            "выдана занятая строка",
          );
          assert.equal(reminder.leaseUntilMs, now + REMINDER_LEASE_MS);
        }

        const claimedIds = new Set(claimed.map((r) => r.id));
        const after = JSON.parse(readFileSync(file, "utf8")) as {
          rows: Reminder[];
        };
        for (const before of rows) {
          if (claimedIds.has(before.id)) continue;
          const nowRow = after.rows.find((r) => r.id === before.id);
          assert.equal(
            JSON.stringify(nowRow),
            JSON.stringify(before),
            "невыданная строка изменилась",
          );
        }
        return true;
      },
    ),
    { numRuns: 100 },
  );
});

test("P3: не падает на мусоре, не глотает и не портит", async () => {
  const raw = fc.oneof(
    fc.json(),
    fc.string(),
    fc.anything().map((value) => {
      try {
        return JSON.stringify(value) ?? "{";
      } catch {
        return "{";
      }
    }),
  );
  const valid = {
    id: "probe",
    text: "текст",
    mode: "verbatim" as const,
    schedule: { kind: "at" as const, atMs: 1 },
    deliver: { chatId: "42" },
  };

  await fc.assert(
    fc.asyncProperty(raw, async (text) => {
      rmSync(caseDir, { recursive: true, force: true });
      mkdirSync(caseDir, { recursive: true });
      const file = reminderFile();
      writeFileSync(file, text);

      let rows: Reminder[] | null = null;
      let rejection: unknown = null;
      try {
        rows = await list();
      } catch (error) {
        rejection = error;
      }

      if (rows !== null) {
        // Резолв допустим только для настоящей таблицы: исходный текст проверяем
        // независимо от модуля, а сами строки — повтором id через add.
        const parsed: unknown = JSON.parse(text);
        assert.ok(
          typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
            Array.isArray((parsed as { rows?: unknown }).rows),
          "list() принял не таблицу",
        );
        const tableRows = (parsed as { rows: Array<{ id: string }> }).rows;
        if (tableRows.length > 0) {
          await assert.rejects(
            add({ ...valid, id: tableRows[0].id }),
            (error: Error) =>
              error instanceof ReminderStoreError && /id/.test(error.message),
          );
          assert.equal(readFileSync(file, "utf8"), text);
        }
        return true;
      }

      assert.ok(rejection instanceof Error, "отказ не был ошибкой");
      assert.ok(rejection.message.includes(file), "в сообщении нет пути файла");
      if (!readdirSync(dirname(file)).includes("reminders.json")) {
        const backups = readdirSync(dirname(file)).filter((n) =>
          n.startsWith("reminders.json.corrupt-"),
        );
        assert.equal(backups.length, 1, "битый файл не отложен ровно один раз");
        assert.equal(
          readFileSync(join(dirname(file), backups[0]), "utf8"),
          text,
        );
        return true;
      }
      assert.equal(readFileSync(file, "utf8"), text, "файл перезаписан");
      await assert.rejects(add(valid), ReminderStoreError);
      assert.equal(readFileSync(file, "utf8"), text, "файл перезаписан");
      return true;
    }),
    { numRuns: 100 },
  );
});
