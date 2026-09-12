import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolContext } from "eve/tools";

import type { RemindAddAnswer } from "../agent/tools/remind_add.ts";
import type { RemindListAnswer } from "../agent/tools/remind_list.ts";
import type { RemindRemoveAnswer } from "../agent/tools/remind_remove.ts";

// Тесты тулов живут в scripts/: файл рядом с тулами eve счёл бы ещё одним тулом и сборка
// упала бы. Хук резолвинга идёт первым — тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";

const NOW = Date.UTC(2026, 8, 12, 5, 0, 0); // 10:00 в Asia/Tashkent

const dataDir = mkdtempSync(join(tmpdir(), "iva-remind-tools-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
process.env.TELEGRAM_DIGEST_CHAT_ID = "555";
process.env.TELEGRAM_ALLOWED_USER_IDS = "";

const { default: remindAdd } = await import("../agent/tools/remind_add.ts");
const { default: remindList } = await import("../agent/tools/remind_list.ts");
const { default: remindRemove } =
  await import("../agent/tools/remind_remove.ts");
const { list, reminderFile } = await import("../agent/lib/reminder-store.ts");

// Второй аргумент execute — контекст хода; тестам тулов он не нужен, а eve типизирует
// ответ тула как «значение или поток». Тулы напоминаний отвечают значением, и обёртки
// возвращают вызывающему именно его.
const ctx = {} as unknown as ToolContext;

const addReminder = (input: Parameters<typeof remindAdd.execute>[0]) =>
  remindAdd.execute(input, ctx) as Promise<RemindAddAnswer>;
const listReminders = () =>
  remindList.execute({}, ctx) as Promise<RemindListAnswer>;
const removeReminder = (input: Parameters<typeof remindRemove.execute>[0]) =>
  remindRemove.execute(input, ctx) as Promise<RemindRemoveAnswer>;

function resetState(): void {
  process.env.ASSISTANT_TIMEZONE = "Asia/Tashkent";
  process.env.TELEGRAM_DIGEST_CHAT_ID = "555";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "";
  rmSync(reminderFile(), { force: true });
  rmSync(join(dataDir, "reminders.tick"), { force: true });
  for (const name of readdirSync(dataDir)) {
    if (name.includes(".corrupt-"))
      rmSync(join(dataDir, name), { force: true });
  }
}

/** Пульс тика — mtime файла data/reminders.tick. */
function writePulse(atMs: number): void {
  const file = join(dataDir, "reminders.tick");
  writeFileSync(file, `${atMs}\n`);
  const at = new Date(atMs);
  utimesSync(file, at, at);
}

/** Отметка замороженного времени: тул считает срок от Date.now(). */
function frozenNow(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
}

void test("remind_add stores a one-time reminder and answers with the owner-zone time", async (t) => {
  resetState();
  frozenNow(t);

  const answer = await addReminder({ text: "позвонить", at: "in 30m" });
  if (!answer.ok) assert.fail(answer.error);
  assert.equal(answer.now, "2026-09-12 10:00");
  assert.equal(answer.reminder.next_run_at, "2026-09-12 10:30");
  assert.equal(answer.reminder.timezone, "Asia/Tashkent");
  assert.equal(answer.reminder.kind, "at");
  assert.equal(answer.reminder.delivered, null);
  assert.equal(answer.reminder.fired_at, null);
  assert.equal(answer.scheduler.alive, false);
  assert.match(answer.scheduler.warning ?? "", /has not ticked yet/u);

  const rows = await list();
  assert.equal(rows.length, 1);
  const schedule = rows[0].schedule;
  if (schedule.kind !== "at") assert.fail("expected an at schedule");
  assert.equal(schedule.atMs, NOW + 1_800_000);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "createdAt",
    "delivered",
    "error",
    "firedAt",
    "id",
    "nextRunAtMs",
    "schedule",
    "status",
    "text",
  ]);

  writePulse(NOW - 60_000);
  const fresh = await addReminder({ text: "ещё раз", at: "in 45m" });
  if (!fresh.ok) assert.fail(fresh.error);
  assert.equal(fresh.scheduler.alive, true);
  assert.equal(fresh.scheduler.last_tick_at, "2026-09-12 09:59");
  assert.equal(fresh.scheduler.warning, undefined);

  // Постаревший пульс: строка всё равно записана, но модель обязана предупредить, что
  // диспетчер не тикает.
  writePulse(NOW - 10 * 60_000);
  const stale = await addReminder({ text: "простояло", at: "in 1h" });
  if (!stale.ok) assert.fail(stale.error);
  assert.equal(stale.scheduler.alive, false);
  assert.match(stale.scheduler.warning ?? "", /has not ticked since/u);

  rmSync(join(dataDir, "reminders.tick"), { force: true });
  const noPulse = await addReminder({ text: "без пульса", at: "in 1h" });
  if (!noPulse.ok) assert.fail(noPulse.error);
  assert.equal(noPulse.scheduler.alive, false);
  assert.match(noPulse.scheduler.warning ?? "", /has not ticked yet/u);

  // Долг QA T5a: ownerTimeZone вызывается тулом, а кривая зона даёт фолбэк resolveTimeZone,
  // не исключение и не хостовую зону.
  process.env.ASSISTANT_TIMEZONE = "Mars/Olympus";
  const fallback = await addReminder({ text: "в UTC", at: "in 30m" });
  if (!fallback.ok) assert.fail(fallback.error);
  assert.equal(fallback.reminder.timezone, "UTC");
});

void test("remind_add stores a repeating reminder with the first run computed by code", async (t) => {
  resetState();
  frozenNow(t);

  const answer = await addReminder({
    text: "стендап",
    cron: "0 9 * * 1-5",
  });
  if (!answer.ok) assert.fail(answer.error);
  assert.equal(answer.reminder.kind, "cron");
  assert.equal(answer.reminder.cron, "0 9 * * 1-5");
  assert.equal(answer.reminder.next_run_at, "2026-09-14 09:00");

  const rows = await list();
  assert.equal(rows.length, 1);
  const schedule = rows[0].schedule;
  if (schedule.kind !== "cron") assert.fail("expected a cron schedule");
  assert.equal(schedule.tz, "Asia/Tashkent");
  assert.equal(rows[0].nextRunAtMs, Date.UTC(2026, 8, 14, 4));
});

void test("the model cannot choose the recipient: адресат не хранится в строке", async (t) => {
  resetState();
  frozenNow(t);

  const injected = await addReminder({
    text: "x",
    at: "in 5m",
    chatId: "999",
    deliver: { chatId: "999" },
    threadId: 7,
  } as never);
  if (!injected.ok) assert.fail(injected.error);
  const rows = await list();
  assert.equal(rows.length, 1);
  assert.equal(
    "deliver" in rows[0],
    false,
    "адресат берётся из .env в момент срабатывания, а не из строки",
  );

  // Владельца берут из .env: сначала чат дайджеста, иначе первый из allowlist.
  process.env.TELEGRAM_DIGEST_CHAT_ID = "";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123, 456";
  const allowlisted = await addReminder({ text: "y", at: "in 5m" });
  if (!allowlisted.ok) assert.fail(allowlisted.error);
  assert.equal((await list()).length, 2);

  process.env.TELEGRAM_ALLOWED_USER_IDS = " , ";
  const refused = await addReminder({ text: "z", at: "in 5m" });
  if (refused.ok) assert.fail("expected no owner chat");
  assert.match(refused.error, /no owner chat/u);
  assert.equal((await list()).length, 2);
});

void test("a broken table is an error, not a success", async (t) => {
  resetState();
  frozenNow(t);

  writeFileSync(reminderFile(), "{broken");
  const added = await addReminder({ text: "x", at: "in 5m" });
  if (added.ok) assert.fail("expected a damaged table error");
  assert.match(added.error, /damaged/u);

  writeFileSync(reminderFile(), "{broken");
  const listed = await listReminders();
  if (listed.ok) assert.fail("expected a damaged table error");
  assert.match(listed.error, /damaged/u);

  writeFileSync(reminderFile(), "{broken");
  const removed = await removeReminder({ id: "r-000000" });
  if (removed.ok) assert.fail("expected a damaged table error");
  assert.match(removed.error, /damaged/u);

  assert.equal(existsSync(reminderFile()), false);
  const siblings = readdirSync(dataDir).filter((name) =>
    name.includes(".corrupt-"),
  );
  assert.equal(siblings.length, 1);
});

void test("list and remove", async (t) => {
  resetState();
  frozenNow(t);

  for (const input of [
    { text: "через три часа", at: "in 3h" },
    { text: "через час", at: "in 1h" },
    { text: "утренний", cron: "0 9 * * *" },
  ]) {
    const added = await addReminder(input);
    if (!added.ok) assert.fail(added.error);
  }

  const listed = await listReminders();
  if (!listed.ok) assert.fail(listed.error);
  assert.equal(listed.count, 3);
  assert.deepEqual(
    listed.reminders.map((row) => row.text),
    ["через час", "через три часа", "утренний"],
  );
  assert.deepEqual(
    listed.reminders.map((row) => row.delivered),
    [null, null, null],
  );
  assert.equal(listed.timezone, "Asia/Tashkent");

  const first = listed.reminders[0];
  const removed = await removeReminder({ id: first.id });
  if (!removed.ok) assert.fail(removed.error);
  assert.equal(removed.removed.id, first.id);
  assert.equal(removed.removed.text, "через час");

  const again = await removeReminder({ id: first.id });
  if (again.ok) assert.fail("expected a missing id error");
  assert.match(again.error, new RegExp(first.id, "u"));

  const both = await addReminder({
    text: "x",
    at: "in 1h",
    cron: "0 9 * * *",
  });
  if (both.ok) assert.fail("expected exactly one of at or cron");
  assert.match(both.error, /give exactly one of at or cron/u);

  const neither = await addReminder({ text: "x" });
  if (neither.ok) assert.fail("expected exactly one of at or cron");
  assert.match(neither.error, /give exactly one of at or cron/u);
});
