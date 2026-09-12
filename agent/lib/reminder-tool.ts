// Общее для трёх тулов напоминаний: строка напоминания для модели и признак того, что
// диспетчер жив. Читает таблицу и отметку тика, ничего не решает сам.
import type {
  Reminder,
  ReminderMode,
  ReminderStatus,
} from "./reminder-store.ts";
import {
  readTickHeartbeat,
  ReminderTickError,
  REMINDER_TICK_STALE_MS,
} from "./reminder-tick.ts";
import { formatZoned } from "./zoned-time.ts";

export interface ReminderView {
  readonly id: string;
  readonly text: string;
  readonly mode: ReminderMode;
  readonly kind: "at" | "cron";
  readonly cron?: string;
  readonly next_run_at: string;
  readonly timezone: string;
  readonly last_status: ReminderStatus | null;
  readonly last_error: string | null;
}

export function describeReminder(row: Reminder, tz: string): ReminderView {
  return {
    id: row.id,
    text: row.text,
    mode: row.mode,
    kind: row.schedule.kind,
    ...(row.schedule.kind === "cron" ? { cron: row.schedule.expr } : {}),
    next_run_at: formatZoned(row.nextRunAtMs, tz),
    timezone: tz,
    last_status: row.lastStatus,
    last_error: row.lastError,
  };
}

export interface SchedulerStatus {
  readonly alive: boolean;
  readonly last_tick_at: string | null;
  readonly warning?: string;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Жив ли минутный диспетчер по отметке последнего тика. Битая отметка — не повод не
 * ставить напоминание, но и не повод молчать: наружу идёт warning, а не исключение.
 */
export function schedulerStatus(nowMs: number, tz: string): SchedulerStatus {
  let heartbeat: ReturnType<typeof readTickHeartbeat>;
  try {
    heartbeat = readTickHeartbeat();
  } catch (error) {
    if (!(error instanceof ReminderTickError)) throw error;
    return {
      alive: false,
      last_tick_at: null,
      warning: `dispatcher heartbeat unreadable: ${message(error)}`,
    };
  }
  if (heartbeat === null)
    return {
      alive: false,
      last_tick_at: null,
      warning:
        "the reminders dispatcher has not ticked yet on this server; the reminder is stored and fires once it runs - tell the user",
    };
  const lastTickAt = formatZoned(heartbeat.lastTickAtMs, tz);
  if (nowMs - heartbeat.lastTickAtMs <= REMINDER_TICK_STALE_MS)
    return { alive: true, last_tick_at: lastTickAt };
  return {
    alive: false,
    last_tick_at: lastTickAt,
    warning: `the reminders dispatcher has not ticked since ${lastTickAt}; the reminder is stored but will not fire until Iva restarts - tell the user`,
  };
}

/** Ошибка тула: модель читает `error`, ход не падает. */
export function toolFailure(error: unknown): {
  readonly ok: false;
  readonly error: string;
} {
  return { ok: false, error: message(error) };
}
