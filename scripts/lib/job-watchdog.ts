// Дневной сторож (T20 п.4): если за сутки есть провалы расписаний, а агент ни разу не
// проснулся (wake падал или хода не было), владелец получает одно сообщение в сутки.
// Политик и повторов в коде нет: состояние одного сообщения — lastSentAt в
// data/jobs-watchdog.json, а само сообщение отправляет дневное расписание.
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { jobFactsFile, readFactsSync, type JobFact } from "#lib/job-facts.ts";
import {
  OPEN_FAILURES_WINDOW_MS,
  openJobFailures,
  type OpenFailure,
} from "#lib/open-failures.ts";
import type { Translate } from "./job-wake.ts";

export const WATCHDOG_SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class JobWatchdogError extends Error {}

export interface WatchdogState {
  readonly lastSentAt: number;
}

export function watchdogStateFile(dataDir: string): string {
  return `${dataDir}/jobs-watchdog.json`;
}

/** Нет файла — null (ещё не отправляли); битый — явная ошибка, а не «никогда». */
export function readWatchdogState(file: string): WatchdogState | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new JobWatchdogError(
      `${file} unreadable: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JobWatchdogError(
      `${file} damaged (invalid JSON): ${(error as Error).message}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger((parsed as WatchdogState).lastSentAt)
  )
    throw new JobWatchdogError(`${file} is not a watchdog state`);
  return { lastSentAt: (parsed as WatchdogState).lastSentAt };
}

/** Состоявшийся ход агента за окно: ответ (в том числе пустой), а не провал. */
export function agentTurnSeen(facts: readonly JobFact[], now: number): boolean {
  return facts.some(
    (fact) =>
      fact.wake !== null &&
      fact.wake.status !== "failed" &&
      now - fact.wake.at <= OPEN_FAILURES_WINDOW_MS,
  );
}

export function watchdogMessage(
  failures: readonly OpenFailure[],
  tr: Translate,
): string {
  return tr(
    `${failures.length} scheduled job(s) failed in the last 24h and the agent is not responding; run: iva doctor`,
    `за сутки ${failures.length} провалов расписаний, агент не отвечает; iva doctor`,
  );
}

/** Текст к отправке или null: либо провал свежий и агент молчит, либо уже отправляли. */
export function watchdogDecision({
  facts,
  now,
  lastSentAt,
  tr,
}: {
  readonly facts: readonly JobFact[];
  readonly now: number;
  readonly lastSentAt: number | null;
  readonly tr: Translate;
}): string | null {
  const failures = openJobFailures(facts, now);
  if (failures.length === 0) return null;
  if (agentTurnSeen(facts, now)) return null;
  if (lastSentAt !== null && now - lastSentAt < WATCHDOG_SEND_INTERVAL_MS)
    return null;
  return watchdogMessage(failures, tr);
}

export interface WatchdogDeps {
  readonly dataDir: string;
  readonly tr: Translate;
  readonly send: (text: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

/** Один прогон сторожа: решить, отправить, отметить. Возвращает текст или null. */
export async function runJobWatchdog(
  deps: WatchdogDeps,
): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const log =
    deps.log ??
    ((...args: unknown[]) => console.log(new Date().toISOString(), ...args));
  const stateFile = watchdogStateFile(deps.dataDir);
  const facts = readFactsSync(jobFactsFile(deps.dataDir));
  const state = readWatchdogState(stateFile);
  const message = watchdogDecision({
    facts,
    now,
    lastSentAt: state?.lastSentAt ?? null,
    tr: deps.tr,
  });
  if (message === null) {
    log("watchdog: nothing to send");
    return null;
  }
  const sent = await deps.send(message);
  if (!sent) {
    // Не отметили — следующее расписание попробует снова; суточный интервал считаем
    // от состоявшейся отправки, а не от попытки.
    log("watchdog: message not sent — will retry on the next run");
    return message;
  }
  writeFileAtomicSync(stateFile, JSON.stringify({ lastSentAt: now }, null, 2), {
    mode: 0o600,
  });
  log(`watchdog: sent "${message}"`);
  return message;
}
