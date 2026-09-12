// Минутный тик диспетчера напоминаний: забрать просроченные строки таблицы напоминаний и
// отдать каждую своему дочернему процессу. Доставка живёт в scripts/reminders/deliver.ts
// (T6): authored tree не может импортировать транспорт Telegram
// (scripts/authored-tree-guard.test.ts), поэтому тик спавнит скрипт по имени.
//
// Два тика одновременно безопасны по построению: claimDue под локом отдаёт строку ровно
// одному тику, аренда строки 10 минут, а дочерний процесс убивается на девятой - к
// следующему тику строка либо закрыта, либо снова свободна.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { writeFileAtomicSync } from "./fs-atomic.ts";
import {
  REMINDER_LEASE_MS,
  ReminderStoreError,
  claimDue,
  complete,
  list,
  type Reminder,
} from "./reminder-store.ts";
import {
  runScheduledJob,
  type RunScheduledJobOptions,
  type RunScheduledJobResult,
} from "./schedule-runner.ts";

/** Строк за тик; остальное заберёт следующий тик. */
export const REMINDER_CLAIM_LIMIT = 5;
/** Тик старше этого — планировщик не жив. */
export const REMINDER_TICK_STALE_MS = 3 * 60_000;

const TICK_SCHEMA_VERSION = 1;

export class ReminderTickError extends Error {}

export interface TickHeartbeat {
  readonly lastTickAtMs: number;
  readonly claimed: number;
}

export function tickHeartbeatFile(): string {
  return join(dataDir(), "reminders-tick.json");
}

/**
 * Отметка последнего тика. Файла нет — null (свежая установка, `eve dev`); битый или
 * чужой файл — явная ошибка с путём: молча вернуть null значило бы сказать «тиков не
 * было» там, где на самом деле испорчены данные.
 */
export function readTickHeartbeat(): TickHeartbeat | null {
  const file = tickHeartbeatFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReminderTickError(`${file} unreadable: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReminderTickError(
      `${file} damaged (invalid JSON): ${message(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== TICK_SCHEMA_VERSION ||
    !isSafeInt(parsed.lastTickAtMs) ||
    !isSafeInt(parsed.claimed)
  )
    throw new ReminderTickError(`${file} is not a reminders tick heartbeat`);
  return { lastTickAtMs: parsed.lastTickAtMs, claimed: parsed.claimed };
}

export interface ReminderTickOptions {
  readonly nowMs?: number;
  readonly limit?: number;
  readonly root?: string;
  readonly nodeBin?: string;
  readonly runJob?: typeof runScheduledJob;
  readonly log?: (...args: unknown[]) => void;
}

export interface ReminderTickResult {
  readonly claimed: number;
  readonly settledByChild: number;
  readonly failedByTick: number;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Чем закончился дочерний процесс, по полям результата runScheduledJob. */
function deliveryFailure(result: RunScheduledJobResult): string {
  if (result.error !== undefined)
    return `delivery process failed to start: ${message(result.error)}`;
  if (result.signal) return `delivery process killed by ${result.signal}`;
  return `delivery process exited ${result.code ?? "unknown"}`;
}

function deliveryOutcome(result: RunScheduledJobResult): string {
  return String(result.code ?? result.signal ?? "unknown");
}

/**
 * Один тик. Никогда не бросает наружу: это обработчик расписания, как и runScheduledJob —
 * сбой самого тика не должен ронять ход планировщика.
 */
export async function runReminderTick(
  options: ReminderTickOptions = {},
): Promise<ReminderTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? REMINDER_CLAIM_LIMIT;
  const root = options.root ?? process.cwd();
  const nodeBin = options.nodeBin ?? process.execPath;
  const runJob = options.runJob ?? runScheduledJob;
  const log =
    options.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));

  let rows: Reminder[];
  try {
    rows = await claimDue(nowMs, limit);
  } catch (error) {
    const failure = message(error);
    log(`reminders: tick failed: ${failure}`);
    return { claimed: 0, settledByChild: 0, failedByTick: 0, error: failure };
  }

  // Отметка — после удачного claim: если таблица недоступна, отметки нет, и экран честно
  // скажет, что планировщик не подтверждён.
  writeFileAtomicSync(
    tickHeartbeatFile(),
    JSON.stringify({
      schemaVersion: TICK_SCHEMA_VERSION,
      lastTickAtMs: nowMs,
      claimed: rows.length,
    }),
    { mode: 0o600 },
  );

  if (rows.length === 0)
    return { claimed: 0, settledByChild: 0, failedByTick: 0 };
  log(
    `reminders: tick claimed ${rows.length}: ${rows.map((row) => row.id).join(", ")}`,
  );

  let settledByChild = 0;
  let failedByTick = 0;

  const settleRow = async (row: Reminder): Promise<void> => {
    const jobOptions: RunScheduledJobOptions = {
      name: `reminder-${row.id}`,
      argv: ["scripts/reminders/deliver.ts", row.id],
      root,
      nodeBin,
      // На минуту короче аренды: процесс обязан умереть раньше, чем строка снова станет
      // свободной.
      timeoutMs: REMINDER_LEASE_MS - 60_000,
      log,
    };
    const result = await runJob(jobOptions);
    const after = (await list()).find((candidate) => candidate.id === row.id);
    if (after === undefined || after.leaseUntilMs === null) {
      settledByChild += 1;
      log(
        `reminders: ${row.id} settled by delivery (code ${deliveryOutcome(result)})`,
      );
      return;
    }
    const failure = deliveryFailure(result);
    try {
      await complete(row.id, {
        nowMs: Date.now(),
        status: "failed",
        error: failure,
      });
    } catch (error) {
      if (error instanceof ReminderStoreError) {
        // Гонка: процесс закрыл строку между чтением и записью.
        settledByChild += 1;
        log(`reminders: ${row.id} outcome already recorded: ${message(error)}`);
        return;
      }
      throw error;
    }
    failedByTick += 1;
    log(`reminders: ${row.id} failed: ${failure}`);
  };

  const outcomes = await Promise.allSettled(rows.map((row) => settleRow(row)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== "rejected") return;
    failedByTick += 1;
    log(
      `reminders: ${rows[index]?.id} tick handler threw: ${message(outcome.reason)}`,
    );
  });

  return { claimed: rows.length, settledByChild, failedByTick };
}
