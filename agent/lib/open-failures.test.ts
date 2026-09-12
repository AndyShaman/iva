/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// «Незакрытые провалы за сутки» (T20 п.3): закрытие успехом и ack, окно суток,
// напоминания рядом с расписаниями, пустой блок.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPEN_FAILURES_WINDOW_MS,
  openFailures,
  openFailuresFrom,
  openFailuresMarkdown,
  openJobFailures,
  openReminderFailures,
} from "./open-failures.ts";
import { jobFactsFile, recordFact, type JobFact } from "./job-facts.ts";
import type { Reminder } from "./reminder-store.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-daily",
    startedAt: NOW - 1000,
    finishedAt: NOW,
    ok: true,
    error: null,
    exitCode: 0,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    text: "позвонить",
    mode: "verbatim",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    nextRunAtMs: NOW,
    lastRunAtMs: NOW - HOUR,
    lastStatus: "failed",
    lastError: "TELEGRAM_BOT_TOKEN is missing",
    deliver: { chatId: "1" },
    leaseUntilMs: null,
    deliveredKey: null,
    ...overrides,
  };
}

test("провал расписания открыт, закрывается успехом и ack", () => {
  const failed = fact({ ok: false, error: "exited 1" });
  assert.deepEqual(
    openJobFailures([failed], NOW).map((entry) => entry.name),
    ["memory-daily"],
  );
  assert.equal(
    openJobFailures([failed, fact({ ok: true, finishedAt: NOW + 1 })], NOW)
      .length,
    0,
    "поздний успех закрывает",
  );
  assert.equal(
    openJobFailures(
      [
        fact({
          ok: false,
          error: "exited 1",
          finishedAt: NOW - 2 * HOUR,
          acked: true,
        }),
      ],
      NOW,
    ).length,
    0,
    "ack закрывает",
  );
});

test("провал старше суток не показывается, пустой список — пусто", () => {
  const old = fact({
    ok: false,
    error: "exited 1",
    finishedAt: NOW - OPEN_FAILURES_WINDOW_MS - HOUR,
  });
  assert.equal(openJobFailures([old], NOW).length, 0);
  assert.equal(openJobFailures([], NOW).length, 0);
});

test("причина без error не исчезает", () => {
  const [failure] = openJobFailures([fact({ ok: false, error: null })], NOW);
  assert.equal(failure?.reason, "провал без причины");
});

test("провал напоминания виден по lastStatus и lastError", () => {
  const open = openReminderFailures([reminder()], NOW);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.name, "reminder-r1");
  assert.match(open[0]?.reason ?? "", /TELEGRAM_BOT_TOKEN/u);
  assert.equal(
    openReminderFailures([reminder({ lastStatus: "ok" })], NOW).length,
    0,
  );
  assert.equal(
    openReminderFailures([reminder({ lastError: null })], NOW).length,
    0,
  );
  assert.equal(
    openReminderFailures([reminder({ lastRunAtMs: NOW - 2 * day() })], NOW)
      .length,
    0,
  );
});

function day(): number {
  return 24 * HOUR;
}

test("оба источника рядом, старые провалы первыми", () => {
  const failures = openFailuresFrom(
    [fact({ ok: false, error: "exited 3", finishedAt: NOW - 30 * 60 * 1000 })],
    [reminder({ lastRunAtMs: NOW - 2 * HOUR })],
    NOW,
  );
  assert.deepEqual(
    failures.map((entry) => entry.source),
    ["reminder", "job"],
  );
});

test("блок для промпта: пусто — пустая строка, иначе имя, время и причина", () => {
  assert.equal(openFailuresMarkdown([]), "");
  const text = openFailuresMarkdown(
    openFailuresFrom(
      [fact({ ok: false, error: "exited 1" })],
      [reminder()],
      NOW,
    ),
  );
  assert.match(text, /^## Незакрытые провалы за сутки/u);
  assert.match(text, /memory-daily/u);
  assert.match(text, /iva jobs ack memory-daily/u);
  assert.match(text, /reminder-r1/u);
});

test("openFailures читает факты с диска и напоминания из источника", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t20-open-"));
  await recordFact(
    jobFactsFile(dir),
    fact({ ok: false, error: "exited 2" }),
    NOW,
  );
  const failures = await openFailures({
    dir,
    now: NOW,
    readReminders: () => Promise.resolve([reminder()]),
  });
  assert.deepEqual(failures.map((entry) => entry.name).sort(), [
    "memory-daily",
    "reminder-r1",
  ]);
});

test("динамическая инструкция 40-open-failures отдаёт тот же блок", async () => {
  const module = await import("../instructions/40-open-failures.ts");
  assert.equal(typeof module.openFailuresMarkdown, "function");
  assert.ok(module.default, "инструкция объявлена");
});
