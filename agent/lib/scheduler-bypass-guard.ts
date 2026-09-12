// Гвард T2: свои таймеры и отправки в Telegram из bash режем до exec. Судим позиции
// commandPositions (self-restart-guard.ts) — кавычки/экранирование/обёртки уже сняты.
// Прямой список: команды, пути, читатели. Чтение и штатные пути не режем.
import { commandPositions } from "./self-restart-guard.ts";

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
const BAN_COMMANDS: Record<string, string> = {
  "systemd-run": WHAT.SYSTEMD_RUN,
  crontab: WHAT.CRONTAB,
  at: WHAT.AT_BATCH,
  batch: WHAT.AT_BATCH,
};
const BAN_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["systemd/user", WHAT.UNIT_DIR],
  [".iva-scripts", WHAT.SCRIPTS_DIR],
  ["api.telegram.org", WHAT.TELEGRAM_HOST],
];
const READERS = new Set(
  "grep egrep fgrep rg cat head tail less more awk wc diff git jq find fd ls stat file echo printf sed".split(
    " ",
  ),
);
const SYSTEMCTL_LETHAL_VERBS = new Set(
  "start restart reload-or-restart enable reenable link edit".split(" "),
);
const CRONTAB_LIST = /(?:^|\s)-l(?:\s|$)/;
const SED_IN_PLACE = /(?:^|\s)-i/;
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
const SLEEP_THRESHOLD_SECONDS = 60;

// Первое слово позиции без пути: /usr/bin/systemd-run — тот же вызов.
const cmdName = (seg: string): string =>
  (seg.split(/\s+/, 1)[0] ?? "").replace(/^[\w./~-]*\//, "");
const tokens = (segment: string): string[] =>
  segment.split(/\s+/).filter(Boolean);
// Запись — это `>`, кроме dup'а дескриптора (2>&1 — plumbing, не файл).
const writesToFile = (segment: string): boolean =>
  segment.split(/(?=>)/).some((part) => /^>(?!&\d)/.test(part));

function isReader(segment: string): boolean {
  const first = tokens(segment)[0] ?? "";
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (!READERS.has(name)) return false;
  if (name === "sed" && SED_IN_PLACE.test(segment)) return false;
  return !writesToFile(segment);
}

function touchesForeignUnit(segment: string): boolean {
  const parts = tokens(segment).slice(1);
  const armed =
    parts.some((part) => SYSTEMCTL_LETHAL_VERBS.has(part)) ||
    parts.includes("--now"); // disable/mask --now тоже останавливают юнит
  if (!armed) return false;
  return parts
    .filter(
      (part) => !part.startsWith("-") && !SYSTEMCTL_LETHAL_VERBS.has(part),
    )
    .some((unit) => !unit.startsWith("iva"));
}

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

// Правило одной командной позиции; positions/index нужны sleep: таймером его делает
// любая отложенная команда ПОСЛЕ него (кроме второго sleep).
function positionViolation(
  seg: string,
  segs: readonly string[],
  index: number,
): string | null {
  const name = cmdName(seg);
  const banned = BAN_COMMANDS[name];
  if (banned !== undefined)
    return name === "crontab" && CRONTAB_LIST.test(seg) ? null : banned;
  if (name === "systemctl")
    return touchesForeignUnit(seg) ? WHAT.SYSTEMCTL : null;
  for (const [path, what] of BAN_PATHS)
    if (seg.includes(path) && !isReader(seg)) return what;
  if (
    name === "sleep" &&
    sleepSeconds(seg) >= SLEEP_THRESHOLD_SECONDS &&
    segs.slice(index + 1).some((later) => cmdName(later) !== "sleep")
  )
    return WHAT.SLEEP;
  return null;
}

/**
 * Текст отказа, если команда ставит свой таймер или отправляет в Telegram
 * мимо штатных инструментов, иначе null.
 */
export function schedulerBypassViolation(command: string): string | null {
  const positions = commandPositions(command);
  for (let index = 0; index < positions.length; index += 1) {
    const what = positionViolation(positions[index] ?? "", positions, index);
    if (what) {
      return (
        `ЗАБЛОКИРОВАНО: ${what}. Свои таймеры и свои отправки в Telegram из bash ` +
        `запрещены. Напоминания и пользовательские расписания создаёт только инструмент ` +
        `remind: он посчитает время в зоне владельца, вернёт next_run_at и доставит сам. ` +
        `Поставь напоминание им, обходной путь не ищи. Регулярные задачи Ивы - eve-schedule ` +
        `в agent/schedules/.`
      );
    }
  }
  return null;
}
