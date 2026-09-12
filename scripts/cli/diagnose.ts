// `iva diagnose` — one package of evidence for a bug report: a GitHub issue or the
// support chat (agent/skills/report-problem). A thin collector: it takes what the machine
// already knows and cuts secrets BEFORE the file is written. What broke is the model's
// question, not this command's.
//
// Only `scripts/` is imported statically: the CLI has to start on an installation whose
// `agent/` is missing (ADR-0003, scripts/authored-tree-guard.test.ts). The turn journal is
// therefore read where it lies — `data/trace/*.jsonl`, the contract of docs/trace.md — and
// the reminders table as `data/reminders.json`; neither authored module is loaded.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { createDoctorCommand } from "./doctor.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

export type DiagnoseDependencies = {
  readonly now?: () => Date;
};

/** Пометка вырезанного. Тот же вид, что в правилах про evidence (AGENTS.md). */
export const REDACTED = "<redacted>";
/**
 * Значения `.env` короче этого не режутся. Секреты (ключи, токены, bearer, chat id)
 * длиннее восьми знаков всегда; а `ru`, `data`, `codex`, `8723` — конфиг, и вырезание
 * таких значений превратило бы пакет в кашу: `CUSTOM_REASONING=1` съел бы все цифры
 * отчёта, `ASSISTANT_DATA_DIR=data` — все пути. Ключи берутся ИЗ ФАЙЛА (какие есть), а
 * не по шаблону значения.
 */
export const SECRET_MIN_LENGTH = 8;
export const JOURNAL_LINES = 200;
/** Потолок списка на раздел: пакет должен читаться, а не весить мегабайт. */
export const SECTION_ITEM_LIMIT = 100;
/** Потолок поля ошибки: хвост ошибки может нести пользовательский текст, а он не нужен. */
const ERROR_CHARS = 200;
/** Ключи `.env`, значения которых режутся независимо от длины: это личные id владельца. */
const CHAT_ID_KEY = /(?:_CHAT_ID|_USER_IDS|_API_ID)$/u;
const TELEGRAM_TOKEN_RE = /(?<![\w-])\d{5,}:[A-Za-z0-9_-]{25,}(?![\w-])/gu;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
/** Файлы журнала хода: имя дня — единственный контракт каталога (docs/trace.md). */
const TRACE_DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;
/** События провала хода: имена из docs/trace.md, без синонимов. */
const FAILED_TURNS = new Set(["turn.failed", "step.failed", "failed"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Чистая: каждое вхождение секрета, а также всё похожее на токен бота или e-mail,
 * становится пометкой. Секреты режутся ОДНИМ проходом и от длинного к короткому: иначе
 * второй проход резал бы буквы внутри только что вставленной пометки, а короткий секрет
 * съедал бы начало длинного.
 */
export function redact(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  let out = text;
  if (unique.length > 0) {
    out = out.replace(
      new RegExp(unique.map(escapeRegExp).join("|"), "gu"),
      REDACTED,
    );
  }
  return out.replace(TELEGRAM_TOKEN_RE, REDACTED).replace(EMAIL_RE, REDACTED);
}

/**
 * Какие значения `.env` считать секретами. Имена ключей берутся из самого файла: список
 * известных секретов не угадывается по виду значения. Личные id (chat, user, api) режутся
 * любой длины, остальные — от SECRET_MIN_LENGTH знаков.
 */
export function secretValuesFromEnv(env: Record<string, string>): string[] {
  const values: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (CHAT_ID_KEY.test(key)) {
      values.push(
        ...value
          .split(/[,\s]+/u)
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      );
      continue;
    }
    if (value.length >= SECRET_MIN_LENGTH) values.push(value);
  }
  return values;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_CHARS ? message.slice(0, ERROR_CHARS) : message;
}

function tailLines(text: string, limit: number): string {
  const lines = text.split("\n");
  return lines.length <= limit ? text : lines.slice(-limit).join("\n");
}

/** Сколько элементов списка попало в пакет и сколько осталось за потолком. */
function capped(items: readonly string[]): { shown: string[]; rest: number } {
  return {
    shown: items.slice(0, SECTION_ITEM_LIMIT),
    rest: Math.max(0, items.length - SECTION_ITEM_LIMIT),
  };
}

function listOrNone(items: readonly string[]): string {
  if (items.length === 0) return "- (none)";
  const { shown, rest } = capped(items);
  const lines = shown.map((item) => `- ${item}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  return lines.join("\n");
}

function versionsSection(root: string, gitHead: string): string {
  const manifest = readJsonObject(join(root, "package.json"));
  const iva =
    typeof manifest?.version === "string"
      ? manifest.version
      : "unknown (package.json unreadable)";
  const dependencies = manifest?.dependencies;
  const eve =
    typeof dependencies === "object" &&
    dependencies !== null &&
    typeof (dependencies as Record<string, unknown>).eve === "string"
      ? String((dependencies as Record<string, unknown>).eve)
      : "unknown (eve is not in package.json)";
  const commit = gitHead.length > 0 ? ` (git ${gitHead})` : "";
  return `- iva: ${iva}${commit}\n- eve: ${eve}`;
}

function hostSection(): string {
  return [
    `- os: ${os.platform()} ${os.release()} ${os.arch()} (${os.type()})`,
    `- node: ${process.version}`,
  ].join("\n");
}

function remindersSection(dataDir: string, nowMs: number): string {
  const file = join(dataDir, "reminders.json");
  if (!existsSync(file)) return "- no reminders.json on this install";
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `- reminders.json unreadable: ${errorText(error)}`;
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const facts: string[] = [];
  let unreadable = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      unreadable++;
      continue;
    }
    const record = row as Record<string, unknown>;
    const last =
      typeof record.lastRunAtMs === "number" ? record.lastRunAtMs : null;
    const due =
      typeof record.nextRunAtMs === "number" ? record.nextRunAtMs : null;
    // Факт за сутки — то, что сработало за последние сутки, и то, что висит просроченным
    // прямо сейчас: молчащий диспетчер виден именно по второму.
    const recent = last !== null && nowMs - last <= DAY_MS;
    const overdue = due !== null && due <= nowMs;
    if (!recent && !overdue) continue;
    const status =
      record.lastStatus === "ok"
        ? "yes"
        : record.lastStatus === "failed"
          ? "no"
          : "never";
    const error =
      typeof record.lastError === "string" && record.lastError.length > 0
        ? errorText(record.lastError)
        : "none";
    facts.push(
      `${String(record.id)} · due ${due === null ? "-" : new Date(due).toISOString()} · ` +
        `last ${last === null ? "-" : new Date(last).toISOString()} · delivered ${status} · ` +
        `error ${error}`,
    );
  }
  const { shown, rest } = capped(facts);
  const lines = shown.map((fact) => `- ${fact}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  if (unreadable > 0) lines.push(`- ${unreadable} unreadable rows skipped`);
  return lines.length > 0
    ? lines.join("\n")
    : "- no reminder facts in the last day";
}

/** Один провал — одна строка: код, а не текст ошибки: текст может нести сообщение. */
function failureFact(event: Record<string, unknown>): string | null {
  const kind = event.kind;
  const name = event.name;
  if (typeof kind !== "string" || typeof name !== "string") return null;
  const failed =
    (kind === "eve" && FAILED_TURNS.has(name)) ||
    ((kind === "outbox" || kind === "stop") && name === "failed");
  if (!failed) return null;
  const data =
    typeof event.data === "object" && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {};
  const code =
    typeof data.errorCode === "string"
      ? data.errorCode
      : typeof data.code === "string" || typeof data.code === "number"
        ? String(data.code)
        : "-";
  const turn =
    typeof event.turn === "string" && event.turn.length > 0 ? event.turn : "-";
  const ts =
    typeof event.ts === "string" && event.ts.length > 0 ? event.ts : "-";
  return `${ts} · ${kind}.${name} · turn ${turn} · code ${code}`;
}

function turnsSection(dataDir: string, nowMs: number): string {
  const directory = join(dataDir, "trace");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return "- no data/trace — the turn journal has nothing";
  }
  const days = names
    .filter((name) => TRACE_DAY_FILE.test(name))
    .sort()
    .reverse();
  const since = nowMs - DAY_MS;
  const facts: string[] = [];
  let unreadable = 0;
  // Двух последних дневных файлов хватает на сутки: ход идёт от сегодняшнего дня назад.
  for (const day of days.slice(0, 2)) {
    let text: string;
    try {
      text = readFileSync(join(directory, day), "utf8");
    } catch {
      unreadable++;
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("not an object");
        event = parsed as Record<string, unknown>;
      } catch {
        unreadable++;
        continue;
      }
      const ts =
        typeof event.ts === "string" ? Date.parse(event.ts) : Number.NaN;
      if (Number.isFinite(ts) && ts < since) continue;
      const fact = failureFact(event);
      if (fact) facts.push(fact);
    }
  }
  const { shown, rest } = capped(facts);
  const lines = shown.map((fact) => `- ${fact}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  if (unreadable > 0)
    lines.push(`- ${unreadable} unreadable journal lines skipped`);
  return lines.length > 0
    ? lines.join("\n")
    : "- no failed turns in the last day";
}

/** Имена файлов своего слоя, без содержимого: что владелец правил — видно, что там — нет. */
function customLayerSection(dataDir: string): string {
  const root = join(dataDir, "custom", "agent");
  const names: string[] = [];
  const visit = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path =
        relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) names.push(path);
    }
  };
  visit("");
  names.sort();
  return listOrNone(names);
}

/** Новейший файл журнала из data/logs: у self-host это единственный лог, который есть. */
function newestLogFile(dataDir: string): { name: string; text: string } | null {
  const directory = join(dataDir, "logs");
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      return {
        name,
        text: tailLines(
          readFileSync(join(directory, name), "utf8"),
          JOURNAL_LINES,
        ),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Последние строки журнала сервиса: journalctl по службам Ивы; нет journalctl — говорим
 * об этом честно и отдаём новейший файл журнала, если он есть.
 */
function journalSection(
  cap: CliRuntime["cap"],
  dataDir: string,
  units: readonly string[],
): string {
  const args = [
    "--user",
    ...units.flatMap((unit) => ["-u", unit]),
    "-n",
    String(JOURNAL_LINES),
    "--no-pager",
  ];
  const result = cap("journalctl", args);
  if (result.code === 0 && result.out.trim().length > 0) return result.out;
  const fallback = newestLogFile(dataDir);
  if (fallback) {
    return (
      `journalctl did not return the unit journal (${result.err || "no output"}); ` +
      `newest log file data/logs/${fallback.name}\n\n${fallback.text}`
    );
  }
  return (
    `journalctl unavailable (${result.err || "no journalctl on this host"}) — ` +
    "read the service journal where the service logs: journalctl --user -u iva.service -n 200, " +
    "or the terminal that started it"
  );
}

function packageMarkdown(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly gitHead: string;
  readonly now: Date;
  readonly doctor: string;
  readonly journal: string;
}): string {
  const nowMs = input.now.getTime();
  return [
    "# Iva diagnose package",
    "",
    `- collected: ${input.now.toISOString()}`,
    `- data dir: ${input.dataDir}`,
    "",
    "## Versions",
    versionsSection(input.root, input.gitHead),
    "",
    "## Host",
    hostSection(),
    "",
    "## iva doctor",
    "```",
    input.doctor.trimEnd(),
    "```",
    "",
    `## Service journal (last ${JOURNAL_LINES} lines)`,
    "```",
    input.journal.trimEnd(),
    "```",
    "",
    "## Reminders (last 24h and overdue)",
    remindersSection(input.dataDir, nowMs),
    "",
    "## Failed turns (last 24h)",
    turnsSection(input.dataDir, nowMs),
    "",
    "## Custom layer (file names only)",
    customLayerSection(input.dataDir),
    "",
  ].join("\n");
}

/**
 * `iva diagnose`: собрать пакет, вырезать секреты, записать в data/diagnose/<дата-время>.md
 * и напечатать путь. Доктор зовётся НАСТОЯЩИЙ — он и есть половина улик, — но со сборщиком
 * без цвета и с выходом, который не завершает этот процесс.
 */
export function createDiagnoseCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DiagnoseDependencies = {},
) {
  const {
    ROOT,
    ok,
    readEnv,
    dataDirAbs,
    cap,
    gitHead,
    SERVICES,
    BRAIN_SERVICE,
    SVC_USERBOT,
  } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const units = [...SERVICES, BRAIN_SERVICE, SVC_USERBOT];

  return async function cmdDiagnose(): Promise<void> {
    const env = readEnv();
    const dataDirectory = dataDirAbs(env);
    const collectedAt = now();
    // Доктор — половина улик, поэтому зовётся настоящий: его строки уходят в пакет, а не в
    // терминал (сборщик без цвета и с выходом, который не завершает этот процесс).
    const doctorLines: string[] = [];
    const doctorRuntime: CliRuntime = {
      ...runtime,
      C: NO_COLOR,
      ok: (message: string) => void doctorLines.push(`✓ ${message}`),
      warn: (message: string) => void doctorLines.push(`! ${message}`),
      bad: (message: string) => void doctorLines.push(`✗ ${message}`),
    };
    await createDoctorCommand(doctorRuntime, systemdLifecycle, {
      log: (...args: unknown[]) => {
        doctorLines.push(args.map((arg) => String(arg)).join(" "));
      },
      exit: () => undefined,
    })();
    const text = packageMarkdown({
      root: ROOT,
      dataDir: dataDirectory,
      gitHead: gitHead(),
      now: collectedAt,
      doctor: doctorLines.join("\n"),
      journal: journalSection(cap, dataDirectory, units),
    });
    const file = join(
      dataDirectory,
      "diagnose",
      `${collectedAt.toISOString().replace(/[:.]/gu, "-")}.md`,
    );
    mkdirSync(join(dataDirectory, "diagnose"), { recursive: true });
    writeFileSync(file, redact(text, secretValuesFromEnv(env)), {
      encoding: "utf8",
      mode: 0o600,
    });
    ok(`Diagnose package: ${file}`);
  };
}
