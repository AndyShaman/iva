// `iva diagnose` — one package of evidence for a bug report: a GitHub issue or the
// support chat (agent/skills/report-problem). A thin collector: it takes what the machine
// already knows and cuts secrets BEFORE the file is written. What broke is the model's
// question, not this command's.
//
// Only `scripts/` is imported statically: the CLI has to start on an installation whose
// `agent/` is missing (ADR-0003, scripts/authored-tree-guard.test.ts). The turn journal is
// therefore read where it lies — `data/trace/*.jsonl`, the contract of docs/trace.md — and
// the reminders table as `data/reminders.json`; neither authored module is loaded.
import { createHash } from "node:crypto";
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
export const JOURNAL_LINES = 200;
/** Потолок списка на раздел: пакет должен читаться, а не весить мегабайт. */
export const SECTION_ITEM_LIMIT = 100;
/** Потолок текста ошибки: в тело ответа апстрим кладёт что угодно, а нужен только код. */
const ERROR_CHARS = 200;
/**
 * id строки напоминания в пакете — короткий хеш, а не id. Имя строки задаёт владелец, и
 * текстовый слаг («напомни-про-подарок») увёз бы его слова в issue; сверить же строку
 * можно и по хешу: sha256 от id, первые восемь знаков.
 */
export function reminderIdHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

/** Потолок кода ошибки хода: код — короткое слово, а не текст. */
const TRACE_CODE_CHARS = 60;
/**
 * Имя ключа `.env`, значение которого НЕ секрет: каталог, модель, провайдер, зона, язык,
 * порт, хост, окно контекста, усилие, режим, ник бота. Режется значение любого другого
 * ключа файла, какой бы длины оно ни было, — список секретов не словарь английских слов, а
 * дополнение к этому списку настроек. Иначе секрет в ключе без слова-приметы уезжает в
 * issue: пароль внутри `CUSTOM_BASE_URL=https://user:pass@host` (ключ из `.env.example`),
 * `CUSTOM_ENDPOINT`, `PROXY`, `*_DSN`, `*_COOKIE`, `SALT`, `PIN`, `OTP` и инвайт-ссылка
 * `SUPPORT_CHAT_URL` в чат владельца (слепая приёмка T21, раунд 3). Настройки остаются
 * целыми не для красоты: `ASSISTANT_DATA_DIR=data` и `ASSISTANT_VAULT_DIR=vault` — слова
 * внутри путей самого пакета, и вырезание съедало их из каждой строки (раунд 2). Список
 * сверяется тестом с `.env.example` и с описью
 * `agent/skills/security-defense/outbound-sensitive-keys.json`.
 */
const CONFIG_KEY =
  /(?:^|_)(?:DIR|MODEL|PROVIDER|TIMEZONE|LANGUAGE|LANG|PORT|WINDOW|EFFORT|MODE|USERNAME|REASONING|MAX_OUTPUT)$|^(?:NODE_ENV|TZ)$/iu;
/** `*_HOST`: настройка, только пока в значении нет ни владельца (`@`), ни пароля после `:`. Со схемой — тоже настройка (`http://host[:port]`), но не с путём и не с userinfo. */
const HOST_KEY = /(?:^|_)HOST$/iu;
const PLAIN_HOST = /^[^\s@:]+(?::\d+)?$/u;
const SCHEME_HOST = /^https?:\/\/[^\s/@:]+(?::\d+)?$/u;
/**
 * Пароль внутри значения с владельцем: `https://user:pass@host`, `user:pass@host`. Значение
 * режется целиком, но в журнал пароль попадает и отдельным словом — строкой апстрима или
 * текстом ошибки, — а целого URL там нет, и по одному полному значению он оставался
 * открытым (слепая приёмка T21, раунд 3).
 */
const URL_PASSWORD = /^(?:[A-Za-z][A-Za-z\d+.-]*:\/\/)?[^\s/@:]*:([^\s/@]+)@/u;
/** Ключи со списком личных id: их значения делятся по запятой и пробелам. */
const CHAT_ID_KEY = /(?:_CHAT_ID|_USER_IDS|_API_ID)$/u;
/**
 * Токен бота в ЛЮБОМ месте строки. Границы слова тут вредны: в журнале токен стоит внутри
 * URL — `api.telegram.org/bot<token>/sendMessage`, — и lookbehind срывался на букве `t`
 * из `bot`, пропуская чужой токен в пакет (T21). У формы `<5+ цифр>:<25+ знаков>` ложных
 * срабатываний нет, поэтому режем без оглядки на соседей.
 */
const TELEGRAM_TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{25,}/gu;
/**
 * Личный id рядом с меткой: `tg:555000111222:43`, `chat_id=…`, `chatId: …`, `from=…`.
 * Работает БЕЗ `.env` — иначе chat id из журнала хода уезжает в пакет (личные данные).
 * Голые длинные числа не трогаем: тогда пакет превратился бы в кашу из времён и размеров.
 */
const TELEGRAM_ID_RE =
  /((?:tg|chat|chatId|chat_id|userId|user_id|from|to)(?::|=|%3A|%3D)\s*)\d{5,}/giu;
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
 * Формы, в которых один и тот же секрет попадает в журнал: сырая, percent-encoded
 * (Basic-строки и куски запросов), JSON-экранированная (тело запроса уехало в лог целиком)
 * и base64/base64url (заголовки авторизации). Список — функция от секрета, поэтому режется
 * всё, чем секрет может приехать, а не только то, как он лежит в `.env`.
 */
function secretForms(secret: string): string[] {
  return [
    secret,
    // Многострочное значение (кавычка в `.env`) приезжает в журнал и построчно: каждая
    // непустая строка — такая же форма секрета, как целое значение (слепая приёмка T21).
    ...secret
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ];
}

/**
 * Чистая: каждая форма секрета, токен бота в любом месте строки, личный id рядом с меткой и
 * e-mail становятся пометкой. Формы режутся ОДНИМ проходом и от длинной к короткой: иначе
 * второй проход резал бы буквы внутри только что вставленной пометки, а короткая форма
 * съедала бы начало длинной (короткий секрет-префикс оставлял хвост длинного — T21).
 * Форма короче 4 знаков режется только на границе слова: однобуквенный пароль `p` внутри
 * `https://u:p@host` выделяется и так (`:p@`), а `package` и `output` остаются целыми (T26).
 * Порог — строго ниже минимальной длины секрета в property-тесте (4): четырёхзначные
 * формы обязаны резаться везде, даже приклеенными к мусору, иначе тест «ни одна форма
 * не выживает» краснеет контрпримером вида `0!!!!` (проверено: при пороге 5 он красный).
 */
const SHORT_FORM = 4;
function formPattern(form: string): string {
  const raw = escapeRegExp(form);
  return form.length < SHORT_FORM
    ? `(?<![\\p{L}\\p{N}])${raw}(?![\\p{L}\\p{N}])`
    : raw;
}
export function redact(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets)
    for (const form of secretForms(secret))
      if (form.length > 0) forms.add(form);
  const ordered = [...forms].sort((left, right) => right.length - left.length);
  let out = text;
  if (ordered.length > 0) {
    out = out.replace(
      new RegExp(ordered.map(formPattern).join("|"), "gu"),
      REDACTED,
    );
  }
  return out
    .replace(TELEGRAM_TOKEN_RE, REDACTED)
    .replace(TELEGRAM_ID_RE, `$1${REDACTED}`)
    .replace(EMAIL_RE, REDACTED);
}

/**
 * Какие значения `.env` считать секретами. Имена ключей берутся из самого файла: список
 * не угадывается по виду значения. Секрет — значение ЛЮБОГО ключа, кроме настроечных
 * (CONFIG_KEY, `*_HOST` без владельца и пароля): неизвестный и пользовательский ключ по
 * умолчанию режется, потому что задача тут — утечка, а не полнота пакета. Пустое значение
 * не режется (пометка вместо пустоты выглядела бы как найденный секрет). Ветвь CHAT_ID_KEY
 * делит значение на части: личные id пишут через запятую.
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
    if (CONFIG_KEY.test(key)) continue;
    if (
      HOST_KEY.test(key) &&
      (PLAIN_HOST.test(value) || SCHEME_HOST.test(value))
    )
      continue;
    values.push(value);
    const password = URL_PASSWORD.exec(value)?.[1];
    if (password) values.push(password);
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

/**
 * Код ошибки вместо её текста. В `lastError` строки напоминания апстрим кладёт тело ответа
 * Telegram (`scripts/lib/telegram-send.ts`), а в теле может лежать текст самого напоминания
 * — владельческий. Кода хватает, чтобы отличить отказ доступа от лимита и от 5xx; имени
 * операции и статуса достаточно, всё остальное в пакет не едет.
 */
function errorCode(raw: string): string {
  const status = /\b[1-5]\d{2}\b/u.exec(raw)?.[0] ?? "";
  const name = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}/u.exec(raw.trim())?.[0] ?? "";
  const code = [name, status].filter(Boolean).join(" ");
  return code.length > 0 ? code : "error text omitted";
}

function capText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
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
        ? errorCode(record.lastError)
        : "none";
    facts.push(
      `${reminderIdHash(String(record.id))} · due ${due === null ? "-" : new Date(due).toISOString()} · ` +
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
      ? capText(data.errorCode, TRACE_CODE_CHARS)
      : typeof data.code === "string" || typeof data.code === "number"
        ? capText(String(data.code), TRACE_CODE_CHARS)
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

/**
 * Строка о том, ЧЕМ вырезано. Без неё пакет с пустым списком секретов выглядел бы так же,
 * как пакет с полным (слепая приёмка T21): владелец и модель обязаны видеть, что `.env`
 * не нашли и работают только шаблонные правила.
 */
function redactionLine(envFound: boolean, secretCount: number): string {
  if (!envFound)
    return (
      "- redaction: .env not found — only the pattern rules were applied " +
      "(bot token, telegram ids, e-mail); values of keys are NOT in the cut list"
    );
  return `- redaction: ${secretCount} values from .env, pattern rules always on`;
}

function packageMarkdown(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly gitHead: string;
  readonly now: Date;
  readonly doctor: string;
  readonly journal: string;
  readonly redaction: string;
}): string {
  const nowMs = input.now.getTime();
  return [
    "# Iva diagnose package",
    "",
    `- collected: ${input.now.toISOString()}`,
    `- data dir: ${input.dataDir}`,
    input.redaction,
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
    "## Reminders (last 24h and overdue; id = sha256/8)",
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
    ENV_PATH,
    ok,
    warn,
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
    const envFound = existsSync(ENV_PATH);
    if (!envFound)
      warn(
        "No .env — redaction applies only the pattern rules (bot token, telegram ids, e-mail); the package says so in its header",
      );
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
    // Доктор мог записать в .env новый внутренний bearer — его значение тоже секрет, и
    // читать список только до прогона значит выпустить свежий ключ в пакет (T21).
    const secrets = [
      ...new Set([
        ...secretValuesFromEnv(env),
        ...secretValuesFromEnv(readEnv()),
      ]),
    ];
    const text = packageMarkdown({
      root: ROOT,
      dataDir: dataDirectory,
      gitHead: gitHead(),
      now: collectedAt,
      doctor: doctorLines.join("\n"),
      journal: journalSection(cap, dataDirectory, units),
      redaction: redactionLine(envFound, secrets.length),
    });
    const file = join(
      dataDirectory,
      "diagnose",
      `${collectedAt.toISOString().replace(/[:.]/gu, "-")}.md`,
    );
    mkdirSync(join(dataDirectory, "diagnose"), { recursive: true });
    writeFileSync(file, redact(text, secrets), {
      encoding: "utf8",
      mode: 0o600,
    });
    ok(`Diagnose package: ${file}`);
  };
}
