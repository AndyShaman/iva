// Таблица напоминаний в data/reminders.json: строки с точным сроком и адресатом,
// атомарная аренда строки на время доставки и версия схемы. Файл, записанный более
// новой версией Ивы, читается как явная ошибка — читать его наугад значит молча
// испортить данные следующей записью. Тик, тул и доставка живут выше (T4-T6) и зовут
// этот модуль; сам модуль ничего не отправляет и никого не будит.
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";

export const REMINDER_SCHEMA_VERSION = 1;
/** Аренда на доставку: «умный» ход живёт до 5 минут, десяти хватает с запасом. */
export const REMINDER_LEASE_MS = 10 * 60_000;

export class ReminderStoreError extends Error {}

export type ReminderMode = "verbatim" | "agent";
/** `at` — один точный срок; `cron` — повторяющееся расписание (cron-выражение пользователя). */
export type ReminderSchedule =
  { kind: "at"; atMs: number } | { kind: "cron"; expr: string; tz: string };
export type ReminderStatus = "ok" | "failed";
export interface Reminder {
  id: string;
  text: string;
  mode: ReminderMode;
  schedule: ReminderSchedule;
  nextRunAtMs: number;
  lastRunAtMs: number | null;
  lastStatus: ReminderStatus | null;
  lastError: string | null;
  deliver: { chatId: string; threadId?: number };
  leaseUntilMs: number | null;
  deliveredKey: string | null;
}
export type ReminderInput = {
  id: string;
  text: string;
  mode: ReminderMode;
  schedule: unknown;
  deliver: { chatId: string; threadId?: number };
  /** Обязателен для kind "cron", запрещён для kind "at". */
  nextRunAtMs?: number;
};
export type ReminderOutcome =
  | { nowMs: number; status: "ok"; deliveredKey: string; nextRunAtMs?: number }
  | { nowMs: number; status: "failed"; error: string; nextRunAtMs?: number };

const ROW_KEYS = [
  "id",
  "text",
  "mode",
  "schedule",
  "nextRunAtMs",
  "lastRunAtMs",
  "lastStatus",
  "lastError",
  "deliver",
  "leaseUntilMs",
  "deliveredKey",
] as const;

function fail(file: string, message: string): never {
  throw new ReminderStoreError(`${file}: ${message}`);
}

function badReminder(file: string, idLabel: string, message: string): never {
  fail(file, `reminder ${idLabel}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

/**
 * Форма расписания, а не его смысл: арифметика следующего запуска для повторяющегося
 * расписания живёт выше этого модуля. Идемпотентна: нормализованное расписание
 * нормализуется в себя.
 */
export function normalizeSchedule(input: unknown): ReminderSchedule {
  if (!isPlainObject(input))
    throw new ReminderStoreError(
      `schedule must be an object, got ${JSON.stringify(input)}`,
    );

  if (input.kind === "at") {
    if (!hasExactKeys(input, ["kind", "atMs"]))
      throw new ReminderStoreError(
        `schedule: kind "at" takes exactly kind and atMs, got ${JSON.stringify(input)}`,
      );
    if (!isSafeInt(input.atMs) || input.atMs < 0)
      throw new ReminderStoreError(
        `schedule: atMs must be a safe integer >= 0, got ${JSON.stringify(input.atMs)}`,
      );
    return { kind: "at", atMs: input.atMs };
  }

  if (input.kind === "cron") {
    if (!hasExactKeys(input, ["kind", "expr", "tz"]))
      throw new ReminderStoreError(
        `schedule: kind "cron" takes exactly kind, expr and tz, got ${JSON.stringify(input)}`,
      );
    if (typeof input.expr !== "string")
      throw new ReminderStoreError(
        `schedule: expr must be a string, got ${JSON.stringify(input.expr)}`,
      );
    const expr = input.expr.trim().replace(/\s+/gu, " ");
    const fields = expr.split(" ");
    if (fields.length !== 5)
      throw new ReminderStoreError(
        `schedule: expr must have exactly 5 fields, got ${fields.length}: ${JSON.stringify(input.expr)}`,
      );
    for (const field of fields) {
      if (!/^[0-9*,/-]+$/u.test(field))
        throw new ReminderStoreError(
          `schedule: expr field ${JSON.stringify(field)} is not a cron field`,
        );
    }
    if (typeof input.tz !== "string" || input.tz.length === 0)
      throw new ReminderStoreError(
        `schedule: tz must be a non-empty string, got ${JSON.stringify(input.tz)}`,
      );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.tz });
    } catch {
      throw new ReminderStoreError(
        `schedule: tz ${JSON.stringify(input.tz)} is not a known IANA time zone`,
      );
    }
    return { kind: "cron", expr, tz: input.tz };
  }

  throw new ReminderStoreError(
    `schedule: kind must be "at" or "cron", got ${JSON.stringify(input.kind)}`,
  );
}

/** Одна проверка формы строки и для add, и для загрузки файла. */
function assertReminder(file: string, value: unknown): Reminder {
  if (!isPlainObject(value))
    fail(file, `reminder row must be an object, got ${JSON.stringify(value)}`);

  const idLabel = JSON.stringify(value.id);

  for (const key of Object.keys(value)) {
    if (!(ROW_KEYS as readonly string[]).includes(key))
      badReminder(file, idLabel, `unknown key ${JSON.stringify(key)}`);
  }

  const id = value.id;
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id)
    fail(
      file,
      `id must be a non-empty string without surrounding whitespace, got ${idLabel}`,
    );

  if (typeof value.text !== "string" || value.text.trim().length === 0)
    badReminder(file, idLabel, "text must be a non-empty string");

  const mode = value.mode;
  if (mode !== "verbatim" && mode !== "agent")
    badReminder(
      file,
      idLabel,
      `mode must be "verbatim" or "agent", got ${JSON.stringify(mode)}`,
    );

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(value.schedule);
  } catch (error) {
    badReminder(file, idLabel, (error as Error).message);
  }

  if (!isSafeInt(value.nextRunAtMs) || value.nextRunAtMs < 0)
    badReminder(
      file,
      idLabel,
      `nextRunAtMs must be a safe integer >= 0, got ${JSON.stringify(value.nextRunAtMs)}`,
    );

  const lastRunAtMs = value.lastRunAtMs;
  if (lastRunAtMs !== null && (!isSafeInt(lastRunAtMs) || lastRunAtMs < 0))
    badReminder(
      file,
      idLabel,
      `lastRunAtMs must be null or a safe integer >= 0, got ${JSON.stringify(lastRunAtMs)}`,
    );

  const leaseUntilMs = value.leaseUntilMs;
  if (leaseUntilMs !== null && (!isSafeInt(leaseUntilMs) || leaseUntilMs < 0))
    badReminder(
      file,
      idLabel,
      `leaseUntilMs must be null or a safe integer >= 0, got ${JSON.stringify(leaseUntilMs)}`,
    );

  const status = value.lastStatus;
  if (status !== null && status !== "ok" && status !== "failed")
    badReminder(
      file,
      idLabel,
      `lastStatus must be null, "ok" or "failed", got ${JSON.stringify(status)}`,
    );

  const lastError = value.lastError;
  if (lastError !== null && typeof lastError !== "string")
    badReminder(
      file,
      idLabel,
      `lastError must be null or a string, got ${JSON.stringify(lastError)}`,
    );

  const deliver = value.deliver;
  if (!isPlainObject(deliver))
    badReminder(file, idLabel, "deliver must be an object");
  for (const key of Object.keys(deliver)) {
    if (key !== "chatId" && key !== "threadId")
      badReminder(
        file,
        idLabel,
        `deliver has unknown key ${JSON.stringify(key)}`,
      );
  }
  if (typeof deliver.chatId !== "string" || deliver.chatId.length === 0)
    badReminder(
      file,
      idLabel,
      `deliver.chatId must be a non-empty string, got ${JSON.stringify(deliver.chatId)}`,
    );
  const threadId = deliver.threadId;
  if (threadId !== undefined && (!isSafeInt(threadId) || threadId <= 0))
    badReminder(
      file,
      idLabel,
      `deliver.threadId must be a positive safe integer, got ${JSON.stringify(threadId)}`,
    );

  const deliveredKey = value.deliveredKey;
  if (
    deliveredKey !== null &&
    !(typeof deliveredKey === "string" && deliveredKey.length > 0)
  )
    badReminder(
      file,
      idLabel,
      `deliveredKey must be null or a non-empty string, got ${JSON.stringify(deliveredKey)}`,
    );

  return {
    id,
    text: value.text,
    mode,
    schedule,
    nextRunAtMs: value.nextRunAtMs,
    lastRunAtMs,
    lastStatus: status,
    lastError,
    deliver: {
      chatId: deliver.chatId,
      ...(threadId === undefined ? {} : { threadId }),
    },
    leaseUntilMs,
    deliveredKey,
  };
}

/** Путь считается на каждом вызове: тесты и T4 меняют ASSISTANT_DATA_DIR между кейсами. */
export function reminderFile(): string {
  return join(dataDir(), "reminders.json");
}

async function loadTable(file: string): Promise<Reminder[]> {
  const raw = await loadJsonStrict<unknown>(file, {
    schemaVersion: REMINDER_SCHEMA_VERSION,
    rows: [],
  });

  if (!isPlainObject(raw) || typeof raw.schemaVersion !== "number")
    fail(file, "no schemaVersion");
  const version = raw.schemaVersion;
  if (!Number.isInteger(version))
    fail(file, `unsupported schemaVersion ${JSON.stringify(version)}`);
  if (version > REMINDER_SCHEMA_VERSION)
    fail(
      file,
      `schemaVersion ${version} is newer than this Iva (${REMINDER_SCHEMA_VERSION}); update Iva or restore the file`,
    );
  if (version < 1) fail(file, `unsupported schemaVersion ${version}`);

  if (!Array.isArray(raw.rows))
    fail(file, `rows must be an array, got ${JSON.stringify(raw.rows)}`);

  const seen = new Set<string>();
  const rows: Reminder[] = [];
  for (const value of raw.rows) {
    const reminder = assertReminder(file, value);
    if (seen.has(reminder.id))
      fail(file, `duplicate reminder id ${JSON.stringify(reminder.id)}`);
    seen.add(reminder.id);
    rows.push(reminder);
  }
  return rows;
}

async function saveTable(file: string, rows: Reminder[]): Promise<void> {
  await saveJsonAtomic(
    file,
    { schemaVersion: REMINDER_SCHEMA_VERSION, rows },
    { mode: 0o600 },
  );
}

/** Мутации — под локом: тик и живой чат ходят в один файл из одного процесса. */
async function mutate<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    return await run();
  } finally {
    releaseLock(lock, token);
  }
}

function byDeadline(a: Reminder, b: Reminder): number {
  if (a.nextRunAtMs !== b.nextRunAtMs) return a.nextRunAtMs - b.nextRunAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildReminder(file: string, input: ReminderInput): Reminder {
  const idLabel = JSON.stringify(input.id);

  let schedule: ReminderSchedule;
  try {
    schedule = normalizeSchedule(input.schedule);
  } catch (error) {
    badReminder(file, idLabel, (error as Error).message);
  }

  let nextRunAtMs: number;
  if (schedule.kind === "at") {
    if (input.nextRunAtMs !== undefined)
      badReminder(file, idLabel, 'nextRunAtMs is not allowed for kind "at"');
    nextRunAtMs = schedule.atMs;
  } else {
    if (input.nextRunAtMs === undefined)
      badReminder(file, idLabel, 'nextRunAtMs is required for kind "cron"');
    if (!isSafeInt(input.nextRunAtMs) || input.nextRunAtMs < 0)
      badReminder(
        file,
        idLabel,
        `nextRunAtMs must be a safe integer >= 0, got ${JSON.stringify(input.nextRunAtMs)}`,
      );
    nextRunAtMs = input.nextRunAtMs;
  }

  return assertReminder(file, {
    id: input.id,
    text: input.text,
    mode: input.mode,
    schedule,
    nextRunAtMs,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    deliver: input.deliver,
    leaseUntilMs: null,
    deliveredKey: null,
  });
}

export async function add(input: ReminderInput): Promise<Reminder> {
  const file = reminderFile();
  const reminder = buildReminder(file, input);
  return mutate(file, async () => {
    const rows = await loadTable(file);
    if (rows.some((row) => row.id === reminder.id))
      fail(file, `duplicate reminder id ${JSON.stringify(reminder.id)}`);
    rows.push(reminder);
    await saveTable(file, rows);
    return structuredClone(reminder);
  });
}

export async function list(): Promise<Reminder[]> {
  const rows = await loadTable(reminderFile());
  return rows.sort(byDeadline).map((row) => structuredClone(row));
}

export async function remove(id: string): Promise<Reminder> {
  const file = reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) fail(file, `reminder ${JSON.stringify(id)} not found`);
    const [removed] = rows.splice(index, 1);
    await saveTable(file, rows);
    return structuredClone(removed);
  });
}

/** Доставка забирает строку на время аренды; границы срока и аренды включительны. */
export async function claimDue(
  nowMs: number,
  limit: number,
): Promise<Reminder[]> {
  const file = reminderFile();
  if (!isSafeInt(nowMs) || nowMs < 0)
    fail(
      file,
      `nowMs must be a safe integer >= 0, got ${JSON.stringify(nowMs)}`,
    );
  if (!isSafeInt(limit) || limit < 1)
    fail(
      file,
      `limit must be a safe integer >= 1, got ${JSON.stringify(limit)}`,
    );

  return mutate(file, async () => {
    const rows = await loadTable(file);
    const due = rows
      .filter(
        (row) =>
          row.nextRunAtMs <= nowMs &&
          (row.leaseUntilMs === null || row.leaseUntilMs <= nowMs),
      )
      .sort(byDeadline)
      .slice(0, limit);
    if (due.length === 0) return [];

    for (const row of due) row.leaseUntilMs = nowMs + REMINDER_LEASE_MS;
    await saveTable(file, rows);
    return due.map((row) => structuredClone(row));
  });
}

/**
 * Итог доставки. Разовое напоминание исполнено и уходит из таблицы; повторяющееся
 * получает следующий срок строго в будущем, иначе следующий тик выдал бы его снова.
 * Повтор той же успешной доставки (at-least-once) ничего не меняет.
 */
export async function complete(
  id: string,
  outcome: ReminderOutcome,
): Promise<Reminder> {
  const file = reminderFile();
  if (!isSafeInt(outcome.nowMs) || outcome.nowMs < 0)
    fail(
      file,
      `reminder ${JSON.stringify(id)}: nowMs must be a safe integer >= 0, got ${JSON.stringify(outcome.nowMs)}`,
    );

  return mutate(file, async () => {
    const rows = await loadTable(file);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) fail(file, `reminder ${JSON.stringify(id)} not found`);
    const row = rows[index];
    const idLabel = JSON.stringify(id);

    if (row.leaseUntilMs === null) {
      if (
        outcome.status === "ok" &&
        row.lastStatus === "ok" &&
        row.deliveredKey === outcome.deliveredKey
      )
        return structuredClone(row);
      badReminder(file, idLabel, "not leased");
    }

    if (outcome.status === "failed") {
      if (outcome.error.length === 0)
        badReminder(file, idLabel, "error must be a non-empty string");
      // Пропущенный срок повторяющегося напоминания уезжает в будущее тем же вызовом:
      // иначе строка осталась бы просроченной и следующий тик выдал бы её снова.
      if (outcome.nextRunAtMs !== undefined) {
        if (
          !isSafeInt(outcome.nextRunAtMs) ||
          outcome.nextRunAtMs <= row.nextRunAtMs
        )
          badReminder(
            file,
            idLabel,
            `nextRunAtMs must be a safe integer greater than ${row.nextRunAtMs}, got ${JSON.stringify(outcome.nextRunAtMs)}`,
          );
        row.nextRunAtMs = outcome.nextRunAtMs;
      }
      row.lastRunAtMs = outcome.nowMs;
      row.lastStatus = "failed";
      row.lastError = outcome.error;
      row.leaseUntilMs = null;
      await saveTable(file, rows);
      return structuredClone(row);
    }

    if (outcome.deliveredKey.length === 0)
      badReminder(file, idLabel, "deliveredKey must be a non-empty string");

    if (row.schedule.kind === "at") {
      if (outcome.nextRunAtMs !== undefined)
        badReminder(file, idLabel, 'nextRunAtMs is not allowed for kind "at"');
      rows.splice(index, 1);
      await saveTable(file, rows);
      return structuredClone(row);
    }

    if (
      !isSafeInt(outcome.nextRunAtMs) ||
      outcome.nextRunAtMs <= row.nextRunAtMs
    )
      badReminder(
        file,
        idLabel,
        `nextRunAtMs must be a safe integer greater than ${row.nextRunAtMs}, got ${JSON.stringify(outcome.nextRunAtMs)}`,
      );
    row.lastRunAtMs = outcome.nowMs;
    row.lastStatus = "ok";
    row.lastError = null;
    row.deliveredKey = outcome.deliveredKey;
    row.leaseUntilMs = null;
    row.nextRunAtMs = outcome.nextRunAtMs;
    await saveTable(file, rows);
    return structuredClone(row);
  });
}

export async function release(id: string): Promise<Reminder> {
  const file = reminderFile();
  return mutate(file, async () => {
    const rows = await loadTable(file);
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      fail(file, `reminder ${JSON.stringify(id)} not found`);
    if (row.leaseUntilMs === null)
      fail(file, `reminder ${JSON.stringify(id)}: not leased`);
    row.leaseUntilMs = null;
    await saveTable(file, rows);
    return structuredClone(row);
  });
}
