/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря контракта таблицы напоминаний: аренда, версия схемы, границы сроков и права файла.
// Путь к файлу считается на каждом вызове, поэтому ASSISTANT_DATA_DIR меняется до импорта
// модуля и ещё раз перед каждым тестом (образец trace.property.test.ts:23-26).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import type { Reminder, ReminderInput } from "./reminder-store.ts";

const root = mkdtempSync(join(tmpdir(), "iva-reminders-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const {
  REMINDER_LEASE_MS,
  ReminderStoreError,
  add,
  claimDue,
  complete,
  list,
  release,
  reminderFile,
  remove,
} = await import("./reminder-store.ts");
const { saveJsonAtomic } = await import("./json-store.ts");

let caseDir = "";
beforeEach(() => {
  caseDir = mkdtempSync(join(root, "case-"));
  process.env.ASSISTANT_DATA_DIR = caseDir;
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** Валидная строка таблицы; поля перекрываются точечно. */
function row(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    id: over.id,
    text: over.text ?? `напоминание ${over.id}`,
    mode: over.mode ?? "verbatim",
    schedule: over.schedule ?? { kind: "at", atMs: 1 },
    nextRunAtMs: over.nextRunAtMs ?? 1,
    lastRunAtMs: over.lastRunAtMs ?? null,
    lastStatus: over.lastStatus ?? null,
    lastError: over.lastError ?? null,
    deliver: over.deliver ?? { chatId: "42" },
    leaseUntilMs: over.leaseUntilMs ?? null,
    deliveredKey: over.deliveredKey ?? null,
  };
}

/** Кладёт таблицу в файл напрямую: тесту нужны состояния, недостижимые через add. */
function seed(rows: Reminder[]): Promise<void> {
  return saveJsonAtomic(
    reminderFile(),
    { schemaVersion: 1, rows },
    { mode: 0o600 },
  );
}

function table(): { schemaVersion: number; rows: Reminder[] } {
  return JSON.parse(readFileSync(reminderFile(), "utf8")) as {
    schemaVersion: number;
    rows: Reminder[];
  };
}

function files(): string[] {
  return readdirSync(dirname(reminderFile())).sort();
}

test("две параллельные аренды не выдают одну строку дважды", async () => {
  const now = 1_000_000;
  await seed([
    row({ id: "a", nextRunAtMs: now - 3 }),
    row({ id: "b", nextRunAtMs: now - 2 }),
    row({ id: "c", nextRunAtMs: now - 1 }),
  ]);

  const [first, second] = await Promise.all([
    claimDue(now, 10),
    claimDue(now, 10),
  ]);

  assert.equal(first.length + second.length, 3);
  assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 3);
  for (const claimed of table().rows)
    assert.equal(claimed.leaseUntilMs, now + REMINDER_LEASE_MS);
});

test("битый JSON: бэкап и ошибка, не пустой список", async () => {
  writeFileSync(reminderFile(), "{broken");

  await assert.rejects(list(), /damaged/);
  assert.equal(existsSync(reminderFile()), false);

  const backups = files().filter((n) =>
    n.startsWith("reminders.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(dirname(reminderFile()), backups[0]), "utf8"),
    "{broken",
  );
});

test("просроченная строка берётся на следующем claim, граница включительно", async () => {
  const now = 5_000_000;
  await seed([
    row({ id: "A", nextRunAtMs: now - 1 }),
    row({ id: "B", nextRunAtMs: now }),
    row({ id: "C", nextRunAtMs: now + 1 }),
  ]);

  const first = await claimDue(now, 10);
  assert.deepEqual(
    first.map((r) => r.id),
    ["A", "B"],
  );

  const second = await claimDue(now + 1, 10);
  assert.deepEqual(
    second.map((r) => r.id),
    ["C"],
  );
});

test("schemaVersion новее кода — явная ошибка", async () => {
  const before = `{\n  "schemaVersion": 2,\n  "rows": []\n}`;
  writeFileSync(reminderFile(), before);

  await assert.rejects(list(), /schemaVersion 2.*newer/);
  assert.equal(readFileSync(reminderFile(), "utf8"), before);

  await assert.rejects(
    add({
      id: "n1",
      text: "текст",
      mode: "verbatim",
      schedule: { kind: "at", atMs: 1 },
      deliver: { chatId: "42" },
    }),
    ReminderStoreError,
  );
  assert.equal(readFileSync(reminderFile(), "utf8"), before);
  assert.deepEqual(files(), ["reminders.json"]);
});

test("истёкшая аренда свободна, живая — нет, повторный claim пуст", async () => {
  const now = 7_000_000;
  await seed([row({ id: "expired", nextRunAtMs: now - 5, leaseUntilMs: now })]);

  const first = await claimDue(now, 10);
  assert.deepEqual(
    first.map((r) => r.id),
    ["expired"],
  );
  assert.deepEqual(await claimDue(now, 10), []);

  await seed([
    row({ id: "live", nextRunAtMs: now - 5, leaseUntilMs: now + 1 }),
  ]);
  assert.deepEqual(await claimDue(now, 10), []);
});

test("add отвергает мусор и не трогает файл", async () => {
  const now = 9_000_000;
  await seed([row({ id: "base", nextRunAtMs: now })]);
  const before = readFileSync(reminderFile(), "utf8");

  const ok: ReminderInput = {
    id: "n1",
    text: "текст",
    mode: "verbatim",
    schedule: { kind: "at", atMs: now },
    deliver: { chatId: "42" },
  };
  const cases: Array<[string, unknown, RegExp]> = [
    ["дубликат id", { ...ok, id: "base" }, /id/],
    ["пустой text", { ...ok, text: "" }, /text/],
    ["пустой text из пробелов", { ...ok, text: "   " }, /text/],
    ["deliver без chatId", { ...ok, deliver: {} }, /chatId/],
    ["чужой mode", { ...ok, mode: "loud" as ReminderInput["mode"] }, /mode/],
    [
      "cron без nextRunAtMs",
      { ...ok, schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" } },
      /nextRunAtMs/,
    ],
    ["at с nextRunAtMs", { ...ok, nextRunAtMs: now + 1 }, /nextRunAtMs/],
    [
      "expr из четырёх полей",
      {
        ...ok,
        schedule: { kind: "cron", expr: "0 8 * *", tz: "UTC" },
        nextRunAtMs: now,
      },
      /expr/,
    ],
    [
      "неизвестная таймзона",
      {
        ...ok,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Mars/Olympus" },
        nextRunAtMs: now,
      },
      /tz/,
    ],
    [
      "threadId 0",
      { ...ok, deliver: { chatId: "42", threadId: 0 } },
      /threadId/,
    ],
  ];

  for (const [name, input, message] of cases) {
    await assert.rejects(
      add(input as ReminderInput),
      (error: Error) =>
        error instanceof ReminderStoreError && message.test(error.message),
      name,
    );
    assert.equal(readFileSync(reminderFile(), "utf8"), before, name);
  }
});

test("жизненный цикл и права 0600", async () => {
  const now = 11_000_000;

  const once = await add({
    id: "one-shot",
    text: "разовое",
    mode: "verbatim",
    schedule: { kind: "at", atMs: now },
    deliver: { chatId: "42" },
  });
  assert.equal(once.nextRunAtMs, now);
  assert.equal(statSync(reminderFile()).mode & 0o777, 0o600);

  const claimedOnce = await claimDue(now, 10);
  assert.deepEqual(
    claimedOnce.map((r) => r.id),
    ["one-shot"],
  );
  await complete("one-shot", {
    nowMs: now,
    status: "ok",
    deliveredKey: "k1",
  });
  assert.deepEqual(await list(), []);

  const cron = await add({
    id: "every-morning",
    text: "повторяющееся",
    mode: "agent",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    nextRunAtMs: now,
    deliver: { chatId: "42", threadId: 7 },
  });
  assert.equal(cron.nextRunAtMs, now);

  const claimedCron = await claimDue(now, 10);
  assert.deepEqual(
    claimedCron.map((r) => r.id),
    ["every-morning"],
  );
  await complete("every-morning", {
    nowMs: now,
    status: "ok",
    deliveredKey: "k2",
    nextRunAtMs: now + 60_000,
  });

  let rows = await list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastStatus, "ok");
  assert.equal(rows[0].lastError, null);
  assert.equal(rows[0].leaseUntilMs, null);
  assert.equal(rows[0].nextRunAtMs, now + 60_000);
  assert.equal(rows[0].deliveredKey, "k2");

  // Повтор той же доставки (at-least-once) ничего не меняет и не бросает.
  await complete("every-morning", {
    nowMs: now + 1,
    status: "ok",
    deliveredKey: "k2",
    nextRunAtMs: now + 60_000,
  });
  rows = await list();
  assert.equal(rows[0].nextRunAtMs, now + 60_000);
  assert.equal(rows[0].lastRunAtMs, now);
  assert.equal(rows[0].deliveredKey, "k2");

  const retry = await claimDue(now + 60_000, 10);
  assert.deepEqual(
    retry.map((r) => r.id),
    ["every-morning"],
  );
  await complete("every-morning", {
    nowMs: now + 60_000,
    status: "failed",
    error: "boom",
  });
  rows = await list();
  assert.equal(rows[0].lastStatus, "failed");
  assert.equal(rows[0].lastError, "boom");
  assert.equal(rows[0].leaseUntilMs, null);
  assert.equal(rows[0].nextRunAtMs, now + 60_000);
  assert.equal(rows[0].deliveredKey, "k2");

  const reclaimed = await claimDue(now + 60_000, 10);
  assert.deepEqual(
    reclaimed.map((r) => r.id),
    ["every-morning"],
  );
  const released = await release("every-morning");
  assert.equal(released.leaseUntilMs, null);
  assert.equal((await list())[0].leaseUntilMs, null);

  await assert.rejects(
    complete("every-morning", {
      nowMs: now,
      status: "ok",
      deliveredKey: "k3",
    }),
    /not leased/,
  );

  await claimDue(now + 60_000, 10);
  await assert.rejects(
    complete("every-morning", {
      nowMs: now,
      status: "ok",
      deliveredKey: "k4",
    }),
    /nextRunAtMs/,
  );
  // Тот же срок снова отдал бы строку следующему тику: двойная доставка.
  await assert.rejects(
    complete("every-morning", {
      nowMs: now,
      status: "ok",
      deliveredKey: "k5",
      nextRunAtMs: now + 60_000,
    }),
    /nextRunAtMs must be a safe integer greater than 11060000/u,
  );

  // Пропущенный срок повторяющегося напоминания уезжает в будущее тем же вызовом,
  // которым отмечен провал: иначе следующий тик выдал бы его снова.
  await assert.rejects(
    complete("every-morning", {
      nowMs: now + 60_000,
      status: "failed",
      error: "gave up on this occurrence: boom",
      nextRunAtMs: now + 60_000,
    }),
    /nextRunAtMs must be a safe integer greater than 11060000/u,
  );
  await complete("every-morning", {
    nowMs: now + 60_000,
    status: "failed",
    error: "gave up on this occurrence: boom",
    nextRunAtMs: now + 120_000,
  });
  rows = await list();
  assert.equal(rows[0].lastStatus, "failed");
  assert.equal(rows[0].lastError, "gave up on this occurrence: boom");
  assert.equal(rows[0].nextRunAtMs, now + 120_000);
  assert.equal(rows[0].deliveredKey, "k2", "провал не трогает ключ доставки");
  assert.equal(rows[0].leaseUntilMs, null);

  await assert.rejects(remove("nope"), /nope/);
  assert.equal(statSync(reminderFile()).mode & 0o777, 0o600);
});
