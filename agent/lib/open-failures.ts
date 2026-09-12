// «Незакрытые провалы за сутки» — то, что агент видит каждым ходом
// (agent/instructions/40-open-failures.ts). Два источника: таблица фактов расписаний и
// таблица напоминаний. T20 напоминания не трогает, но общий источник обязан видеть и их
// провалы: строка напоминания с lastStatus=failed и причиной за сутки считается открытой.
//
// Провал расписания закрыт, когда есть более поздний успешный запуск того же имени или
// владелец/агент закрыл его через `iva jobs ack <name>`. Повторам в коде здесь места нет:
// открытый провал — это состояние, а не событие.
import { dataDir } from "./data-dir.ts";
import {
  jobFactsFile,
  latestFact,
  readFactsSync,
  type JobFact,
} from "./job-facts.ts";
import { list, type Reminder } from "./reminder-store.ts";

export const OPEN_FAILURES_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OpenFailure = {
  readonly source: "job" | "reminder";
  readonly name: string;
  readonly at: number;
  readonly reason: string;
};

function byTime(left: OpenFailure, right: OpenFailure): number {
  return left.at - right.at;
}

export function openJobFailures(
  facts: readonly JobFact[],
  now: number,
): OpenFailure[] {
  const names = [...new Set(facts.map((fact) => fact.name))];
  const failures: OpenFailure[] = [];
  for (const name of names) {
    const latest = latestFact(facts, name);
    if (!latest || latest.ok || latest.acked) continue;
    if (now - latest.finishedAt > OPEN_FAILURES_WINDOW_MS) continue;
    failures.push({
      source: "job",
      name,
      at: latest.finishedAt,
      reason: latest.error ?? "провал без причины",
    });
  }
  return failures.sort(byTime);
}

export function openReminderFailures(
  reminders: readonly Reminder[],
  now: number,
): OpenFailure[] {
  const failures: OpenFailure[] = [];
  for (const row of reminders) {
    if (row.lastStatus !== "failed") continue;
    if (typeof row.lastError !== "string" || row.lastError.length === 0)
      continue;
    if (row.lastRunAtMs === null) continue;
    if (now - row.lastRunAtMs > OPEN_FAILURES_WINDOW_MS) continue;
    failures.push({
      source: "reminder",
      name: `reminder-${row.id}`,
      at: row.lastRunAtMs,
      reason: row.lastError,
    });
  }
  return failures.sort(byTime);
}

export function openFailuresFrom(
  facts: readonly JobFact[],
  reminders: readonly Reminder[],
  now: number,
): OpenFailure[] {
  return [
    ...openJobFailures(facts, now),
    ...openReminderFailures(reminders, now),
  ].sort(byTime);
}

/** Чтение для хода: факты обязательны (битый файл — явная ошибка), напоминания рядом. */
export async function openFailures({
  dir = dataDir(),
  now = Date.now(),
  readReminders = list,
}: {
  readonly dir?: string;
  readonly now?: number;
  readonly readReminders?: () => Promise<readonly Reminder[]>;
} = {}): Promise<OpenFailure[]> {
  const facts = readFactsSync(jobFactsFile(dir));
  const reminders = await readReminders();
  return openFailuresFrom(facts, reminders, now);
}

function line(failure: OpenFailure): string {
  const when = new Date(failure.at).toISOString();
  if (failure.source === "reminder")
    return `- Напоминание ${failure.name}: ${when}, ${failure.reason}`;
  return `- Расписание ${failure.name}: ${when}, ${failure.reason} (закрыть: iva jobs ack ${failure.name})`;
}

/** Блок для промпта; провалов нет — пустая строка (инструкция тогда пустая). */
export function openFailuresMarkdown(failures: readonly OpenFailure[]): string {
  if (failures.length === 0) return "";
  return ["## Незакрытые провалы за сутки", ...failures.map(line)].join("\n");
}
