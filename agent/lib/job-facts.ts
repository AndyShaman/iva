// Таблица фактов расписаний: одна строка на каждый запуск в data/jobs.json. Пишет её
// schedule-runner в конце запуска; читают agent/instructions/40-open-failures.ts,
// `iva doctor` и дневной сторож. Строка говорит, что запускалось, когда, чем кончилось,
// почему и хвост журнала без секретов.
//
// Status-файл расписаний (rollup-status.json) остаётся только гвардам: «идёт сейчас» и
// «последний успех». История запусков — здесь, об одном запуске не два источника правды.
//
// Форма строки — контракт: битая строка пропускается (файл пишем мы сами, не пользователь),
// а чужой корень файла — явная ошибка: молча ответить «запусков не было» значило бы
// выключить и провалы, и сторожа.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";

/** Сколько живёт строка: старше — удаляется при записи. */
export const JOB_FACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Последние строки журнала в факте (п.1 спеки T20). */
export const JOB_TAIL_LINES = 20;
export const JOB_TAIL_MAX_CHARS = 4000;

/** Имена ключей, значения которых не попадают в хвост (см. правила билдера). */
const SECRET_ENV_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|BEARER)$/iu;
/** Телеграм-токен узнаётся и без env: цифры, двоеточие, длинный хвост. */
const TELEGRAM_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu;
const REDACTED = "<redacted>";

export class JobFactsError extends Error {}

export interface JobWake {
  readonly at: number;
  readonly status: "answered" | "empty" | "failed";
  readonly error: string | null;
}

export interface JobFact {
  readonly name: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly ok: boolean;
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly tail: string;
  readonly acked: boolean;
  readonly wake: JobWake | null;
}

export function jobFactsFile(dir: string = dataDir()): string {
  return join(dir, "jobs.json");
}

/**
 * Хвост для факта: последние 20 строк, значения секретных ключей вырезаны. Хвост
 * складывается из stdout+stderr ребёнка, поэтому в него попадает всё, что скрипт
 * печатал, включая случайно выведенный ключ.
 */
export function jobTail(
  tail: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let text = tail.replace(TELEGRAM_TOKEN, REDACTED);
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(name)) continue;
    const secret = (value ?? "").trim();
    if (secret.length < 4) continue;
    text = text.split(secret).join(REDACTED);
  }
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-JOB_TAIL_LINES);
  const joined = lines.join("\n");
  return joined.length > JOB_TAIL_MAX_CHARS
    ? joined.slice(joined.length - JOB_TAIL_MAX_CHARS)
    : joined;
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isWake(value: unknown): value is JobWake {
  if (typeof value !== "object" || value === null) return false;
  const wake = value as Record<string, unknown>;
  return (
    isSafeInt(wake.at) &&
    (wake.status === "answered" ||
      wake.status === "empty" ||
      wake.status === "failed") &&
    (wake.error === null || typeof wake.error === "string")
  );
}

function isFact(value: unknown): value is JobFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Record<string, unknown>;
  return (
    typeof fact.name === "string" &&
    fact.name.length > 0 &&
    isSafeInt(fact.startedAt) &&
    isSafeInt(fact.finishedAt) &&
    fact.finishedAt >= fact.startedAt &&
    typeof fact.ok === "boolean" &&
    (fact.error === null || typeof fact.error === "string") &&
    (fact.exitCode === null || isSafeInt(fact.exitCode)) &&
    typeof fact.tail === "string" &&
    typeof fact.acked === "boolean" &&
    (fact.wake === null || isWake(fact.wake))
  );
}

/** Валидные строки таблицы; битые пропускаются, чужой корень — ошибка с путём. */
export function parseFacts(value: unknown, file: string): JobFact[] {
  if (!Array.isArray(value))
    throw new JobFactsError(`${file} is not a job facts array`);
  return value.filter(isFact);
}

/** Синхронное чтение для инструкции хода: нет файла — пусто, битый — ошибка. */
export function readFactsSync(file: string): JobFact[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new JobFactsError(`${file} unreadable: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JobFactsError(
      `${file} damaged (invalid JSON): ${(error as Error).message}`,
    );
  }
  return parseFacts(parsed, file);
}

export async function readFacts(file: string): Promise<JobFact[]> {
  return parseFacts(await loadJsonStrict<unknown>(file, []), file);
}

function rotated(facts: readonly JobFact[], now: number): JobFact[] {
  const alive = facts.filter(
    (fact) => now - fact.finishedAt <= JOB_FACT_RETENTION_MS,
  );
  return alive.length === facts.length ? [...facts] : alive;
}

async function withFacts<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const token = await acquireLock(`${file}.lock`);
  try {
    return await fn();
  } finally {
    releaseLock(`${file}.lock`, token);
  }
}

/** Записать факт запуска: ротация старше 7 дней и добавление строки под локом. */
export async function recordFact(
  file: string,
  fact: JobFact,
  now: number = Date.now(),
): Promise<void> {
  await withFacts(file, async () => {
    const existing = await readFacts(file);
    await saveJsonAtomic(file, [...rotated(existing, now), fact]);
  });
}

/** Записать исход хода агента в строку запуска; false — строки уже нет. */
export async function recordWake(
  file: string,
  name: string,
  startedAt: number,
  wake: JobWake,
): Promise<boolean> {
  return withFacts(file, async () => {
    const facts = await readFacts(file);
    let found = false;
    const next = facts.map((fact) => {
      if (fact.name !== name || fact.startedAt !== startedAt) return fact;
      found = true;
      return { ...fact, wake };
    });
    if (found) await saveJsonAtomic(file, next);
    return found;
  });
}

/**
 * Закрыть провалы имени вручную: `iva jobs ack <name>`. Возвращает, сколько строк
 * закрыто. Закрывается только последний провал имени — он и есть незакрытый.
 */
export async function ackFacts(file: string, name: string): Promise<number> {
  return withFacts(file, async () => {
    const facts = await readFacts(file);
    const latest = latestFact(facts, name);
    // Незакрытый провал имени — это ровно последняя строка, если она провал.
    if (!latest || latest.ok || latest.acked) return 0;
    await saveJsonAtomic(
      file,
      facts.map((fact) =>
        fact.name === name &&
        fact.startedAt === latest.startedAt &&
        !fact.ok &&
        !fact.acked
          ? { ...fact, acked: true }
          : fact,
      ),
    );
    return 1;
  });
}

/** Последняя строка имени по finishedAt (порядок в файле может быть любым). */
export function latestFact(
  facts: readonly JobFact[],
  name: string,
): JobFact | null {
  let latest: JobFact | null = null;
  for (const fact of facts) {
    if (fact.name !== name) continue;
    if (!latest || fact.finishedAt > latest.finishedAt) latest = fact;
  }
  return latest;
}
