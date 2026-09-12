/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTaskCount } from "./crons.ts";

test("openTaskCount reports only open tasks for array and wrapped storage shapes", () => {
  for (const [value, expected] of [
    [
      [
        { text: "open" },
        { text: "done", done: true },
        { text: "explicit open", done: false },
      ],
      2,
    ] as const,
    [{ tasks: [{ text: "open" }, { text: "done", done: true }] }, 1] as const,
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
    try {
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify(value));
      assert.equal(openTaskCount(dataDir), expected);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test("openTaskCount preserves truthy legacy done semantics", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-task-count-"));
  try {
    writeFileSync(
      join(dataDir, "tasks.json"),
      JSON.stringify([
        { text: "numeric done", done: 1 },
        { text: "string done", done: "yes" },
        { text: "boolean done", done: true },
        { text: "explicit open", done: false },
        { text: "open" },
      ]),
    );
    assert.equal(openTaskCount(dataDir), 2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the ⏰ screen lists the nearest reminders and the dispatcher tick", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-reminders-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dataDir;
  try {
    writeFileSync(join(dataDir, "rollup-status.json"), "{}");
    const { add } = await import("#lib/reminder-store.ts");
    const { formatZoned } = await import("#lib/zoned-time.ts");
    const { resolveTimeZone } = await import("#lib/timezone.ts");
    const { tickHeartbeatFile } = await import("#lib/reminder-tick.ts");
    const now = Date.now();
    const later = await add({
      id: "later",
      text: "позже",
      mode: "verbatim",
      schedule: { kind: "at", atMs: now + 3_600_000 },
      deliver: { chatId: "555" },
    });
    const soon = await add({
      id: "soon",
      text: "скоро",
      mode: "agent",
      schedule: { kind: "at", atMs: now + 60_000 },
      deliver: { chatId: "555" },
    });
    const daily = await add({
      id: "daily",
      text: "каждый день",
      mode: "agent",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Tashkent" },
      nextRunAtMs: now + 7_200_000,
      deliver: { chatId: "555" },
    });
    writeFileSync(
      tickHeartbeatFile(),
      JSON.stringify({
        schemaVersion: 1,
        lastTickAtMs: now - 60_000,
        claimed: 2,
      }),
    );

    const screen = (await import("./crons.ts")) as {
      readonly default: {
        readonly render: (
          state: { page: number },
          ctx: {
            deps: { dataDir: string };
            tr: (english: string, russian: string) => string;
            btn: (text: string, callbackData: string) => unknown;
            backRow: (screen: string) => unknown[];
          },
        ) => Promise<{ text: string }>;
      };
    };
    const context = {
      deps: { dataDir },
      tr: (english: string) => english,
      btn: (text: string, callbackData: string) => ({ text, callbackData }),
      backRow: () => [],
    };
    const tz = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);

    const { text } = await screen.default.render({ page: 0 }, context);
    assert.ok(text.includes("⏰ Reminders"));
    const soonAt = text.indexOf(`• ${formatZoned(soon.nextRunAtMs, tz)} скоро`);
    const laterAt = text.indexOf(
      `• ${formatZoned(later.nextRunAtMs, tz)} позже`,
    );
    const dailyAt = text.indexOf(
      `• ${formatZoned(daily.nextRunAtMs, tz)} (repeats) каждый день`,
    );
    assert.ok(soonAt >= 0, text);
    assert.ok(laterAt > soonAt, text);
    assert.ok(dailyAt > laterAt, text);
    assert.ok(
      text.includes(
        `dispatcher: last tick ${formatZoned(now - 60_000, tz).slice(11)}`,
      ),
      text,
    );

    writeFileSync(
      tickHeartbeatFile(),
      JSON.stringify({
        schemaVersion: 1,
        lastTickAtMs: now - 10 * 60_000,
        claimed: 0,
      }),
    );
    const stale = await screen.default.render({ page: 0 }, context);
    assert.ok(stale.text.includes("dispatcher: no tick since"), stale.text);
    assert.ok(stale.text.includes("⚠️"), stale.text);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
