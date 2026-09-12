// Жёсткий запрет самодельных таймеров и своих отправок в Telegram из bash-тула (T2).
//
// Механика: на проде агент дважды построил обходной путь вместо честного отказа —
// `~/.iva-scripts/remind_sofia.sh` с curl и токеном бота и свой юнит через
// `systemd-run --on-calendar`. Такой скрипт живёт вне Ивы: его не видно среди напоминаний,
// он не спрашивает пользователя, а токен оседает в файле. Промпт-запрета мало (та же
// история, что у #68), поэтому режем детерминированно, ДО exec. Это deterrence, не
// граница: у bash полный host-доступ, обойти можно всегда — цель в том, чтобы модель не
// сделала это СЛУЧАЙНО по прямой просьбе из чата.
//
// Судим командные позиции (`commandPositions` из self-restart-guard.ts): кавычки и
// экранирование снимаются нормализацией, сегменты режутся по `; & | ( ) \` и переводу
// строки, с начала каждого снимаются обёртки (sudo, env, timeout, bash -c, shell-слова
// циклов). Поэтому `rg systemd-run docs/` и `crontab -l` проходят — там нет команды, —
// а любая форма реального вызова ловится под какими угодно обёртками и в кавычках.
//
// Намеренно НЕ блокируем чтение и штатные пути: `crontab -l`, `systemctl --user status`,
// `journalctl`, `list-timers`, `daemon-reload`, юниты `iva*` (летальные имена режет
// self-restart-guard), grep/rg/git по докам и коду, `iva remind`, `iva notify`, `iva post`.
// Регулярные задачи самой Ивы — eve-schedule в `agent/schedules/`.
//
// Принятые ложные срабатывания (обходов не стоят): `command -v systemd-run` (обёртка
// снимает `command -v`, для проверки есть `which`), `grep x ~/.config/systemd/user/a >
// /tmp/out` (вывод в файл — отдельной командой), `curl …/getMe` для проверки бота —
// это делает владелец из терминала.
import { commandPositions } from "./self-restart-guard.ts";

// Путь до бинаря допустим: /usr/bin/systemd-run — тот же вызов.
const BIN = (name: string) =>
  new RegExp(`^(?:[\\w./~-]*\\/)?${name}(?![\\w-])`);

const SYSTEMD_RUN = BIN("systemd-run");
const CRONTAB = BIN("crontab");
const AT_OR_BATCH = new RegExp(`^(?:[\\w./~-]*\\/)?(?:at|batch)(?![\\w-])`);
const SYSTEMCTL = BIN("systemctl");
const SLEEP = BIN("sleep");

const UNIT_DIR = /systemd\/user(?![\w-])/;
const SCRIPTS_DIR = /\.iva-scripts(?![\w-])/;
const TELEGRAM_HOST = /api\.telegram\.org/;

// Чтение — единственный способ упомянуть запретное в командной позиции. `sed -i` пишет,
// поэтому читателем не считается; перенаправление вывода в файл — тоже запись.
const READERS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "awk",
  "wc",
  "diff",
  "git",
  "jq",
  "find",
  "fd",
  "ls",
  "stat",
  "file",
  "echo",
  "printf",
  "sed",
]);

// Летальные глаголы systemctl и чтение crontab — то немногое, что нужно разобрать
// по аргументам, а не по одному regexp.
const SYSTEMCTL_LETHAL_VERBS = new Set([
  "start",
  "restart",
  "reload-or-restart",
  "enable",
  "reenable",
  "link",
  "edit",
]);
const CRONTAB_LIST = /(?:^|\s)-l(?:\s|$)/;
const SED_IN_PLACE = /(?:^|\s)-i/;

const WHAT = {
  SYSTEMD_RUN: "systemd-run: свой таймер",
  CRONTAB: "crontab: запись расписания",
  AT_BATCH: "at/batch: отложенный запуск",
  SYSTEMCTL: "systemctl: запуск или включение своего юнита",
  UNIT_DIR: "запись в ~/.config/systemd/user",
  SCRIPTS_DIR: "~/.iva-scripts: свой скрипт",
  TELEGRAM_HOST: "прямой вызов api.telegram.org",
  SLEEP: "sleep как таймер перед следующей командой",
} as const;

const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
const SLEEP_THRESHOLD_SECONDS = 60;

// Что НЕ делает следующий sleep таймером: управляющие слова, ожидание фонового
// задания, проверка условия, второй sleep, no-op и обрывки редиректов. `exec sleep 3600
// & wait` и `while [ ! -s pid ]; do sleep 0.01; done` — обвязка вокруг самого сна,
// а не отложенная команда; судить нечего. Фоновые формы T2 не трогает вовсе.
const NOT_A_PAYLOAD = new Set([
  "wait",
  "done",
  "fi",
  "then",
  "else",
  "do",
  ":",
  "true",
  "false",
  "test",
  "exit",
]);
// Командное слово, а не хвост `2>`/`1`, который оставил разделитель `&`. `$` в начале —
// форма из промпта (`$HOME/.local/bin/iva`), присваивания (`TZ=UTC iva notify x`) снимаются
// до проверки: непонятная нагрузка после длинного sleep — это блок, а не пропуск.
const COMMAND_WORD = /^[$A-Za-z_./~][\w./~$-]*$/;
const ASSIGNMENT = /^\w+=/;

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

// Запись — это `>` не перед /dev/null и не перед dup'ом файлового дескриптора (2>&1).
function writesToFile(segment: string): boolean {
  for (const match of segment.matchAll(/>/g)) {
    const rest = segment.slice((match.index ?? 0) + 1);
    if (/^&[0-9]/.test(rest)) continue;
    if (/^\s*\/dev\/null(?![\w./-])/.test(rest)) continue;
    return true;
  }
  return false;
}

function isReader(segment: string): boolean {
  const first = tokens(segment)[0] ?? "";
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (!READERS.has(name)) return false;
  if (name === "sed" && SED_IN_PLACE.test(segment)) return false;
  return !writesToFile(segment);
}

function systemctlTouchesForeignUnit(segment: string): boolean {
  const parts = tokens(segment).slice(1);
  const lethal =
    parts.some((part) => SYSTEMCTL_LETHAL_VERBS.has(part)) ||
    parts.includes("--now");
  if (!lethal) return false;
  const units = parts.filter(
    (part) =>
      !part.startsWith("-") &&
      !part.includes("=") &&
      !SYSTEMCTL_LETHAL_VERBS.has(part),
  );
  return units.length > 0 && units.some((unit) => !unit.startsWith("iva"));
}

// Сумма длительностей sleep. Неразбираемый аргумент (`$DELAY`) считается длинным: правило
// не должно зависеть от значения переменной, которую модель подставит в рантайме.
function sleepSeconds(segment: string): number {
  let total = 0;
  for (const token of tokens(segment).slice(1)) {
    if (token.startsWith("-")) continue;
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token);
    if (!match) return Number.POSITIVE_INFINITY;
    total += Number(match[1]) * (SLEEP_UNITS[match[2] || "s"] ?? 1);
  }
  return total;
}

function carriesPayload(segment: string): boolean {
  const first =
    tokens(segment).filter((token) => !ASSIGNMENT.test(token))[0] ?? "";
  if (!COMMAND_WORD.test(first)) return false;
  if (SLEEP.test(segment)) return false;
  return !NOT_A_PAYLOAD.has(first);
}

// Правило одной командной позиции. `positions` и `index` нужны sleep: сам по себе он
// безвреден, таймером его делает отложенная команда ПОСЛЕ него.
function positionViolation(
  segment: string,
  positions: readonly string[],
  index: number,
): string | null {
  if (SYSTEMD_RUN.test(segment)) return WHAT.SYSTEMD_RUN;
  if (CRONTAB.test(segment) && !CRONTAB_LIST.test(segment)) return WHAT.CRONTAB;
  if (AT_OR_BATCH.test(segment)) return WHAT.AT_BATCH;
  if (SYSTEMCTL.test(segment) && systemctlTouchesForeignUnit(segment)) {
    return WHAT.SYSTEMCTL;
  }
  if (UNIT_DIR.test(segment) && !isReader(segment)) return WHAT.UNIT_DIR;
  if (SCRIPTS_DIR.test(segment) && !isReader(segment)) return WHAT.SCRIPTS_DIR;
  if (TELEGRAM_HOST.test(segment) && !isReader(segment))
    return WHAT.TELEGRAM_HOST;
  if (
    SLEEP.test(segment) &&
    sleepSeconds(segment) >= SLEEP_THRESHOLD_SECONDS &&
    positions.slice(index + 1).some(carriesPayload)
  ) {
    return WHAT.SLEEP;
  }
  return null;
}

/**
 * Возвращает текст отказа, если команда ставит свой таймер или отправляет в Telegram
 * мимо штатных инструментов, иначе null. Текст адресован модели: называет правило
 * и замену.
 */
export function schedulerBypassViolation(command: string): string | null {
  const positions = commandPositions(command);
  for (let index = 0; index < positions.length; index += 1) {
    const what = positionViolation(positions[index] ?? "", positions, index);
    if (what) {
      return (
        `ЗАБЛОКИРОВАНО: ${what}. Свои таймеры и свои отправки в Telegram из bash ` +
        `запрещены. Напоминания и пользовательские расписания создаёт только инструмент ` +
        `напоминаний (remind_add, появится в списке инструментов). Пока его нет - честно ` +
        `скажи пользователю, что отложенное напоминание сейчас поставить нельзя, обходной ` +
        `путь не ищи. Регулярные задачи Ивы - eve-schedule в agent/schedules/.`
      );
    }
  }
  return null;
}
