// Точка входа доставки: `node --env-file=.env scripts/reminders/deliver.ts <id>`.
// Запускает её минутный диспетчер напоминаний (agent/lib/reminder-tick.ts) на строке,
// которую уже забрал в аренду; дочерний процесс обязан закрыть строку сам во всех
// исходах, которые пережил, — иначе тик запишет «delivery process exited N».
// Живёт в scripts/, а не в agent/: выталкивание наружу идёт через Telegram
// (scripts/authored-tree-guard.test.ts: agent/ не импортирует scripts/).
// Коды выхода: 0 — исход записан; 1 — строка осталась в аренде (её разберёт тик);
// 2 — ручной запуск мимо аренды или неизвестный id.
import { dataDir } from "#lib/data-dir.ts";
import { nextCronRunMs } from "#lib/reminder-time.ts";
import { complete, list, release, remove } from "#lib/reminder-store.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { settleReminder } from "../lib/reminder-delivery.ts";
import {
  alertOnce,
  alertResolved,
  noticeTranslator,
} from "../lib/notice-policy.ts";
import {
  reminderClientOptions,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (id === undefined || id.trim() === "")
    fail("usage: deliver.ts <reminder id>", 2);

  const row = (await list()).find((candidate) => candidate.id === id);
  if (row === undefined) fail(`reminders: ${id}: unknown id`, 2);
  if (row.leaseUntilMs === null)
    fail(`reminders: ${id}: not leased - run it through the dispatcher`, 2);

  const nowMs = Date.now();
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (token === "") {
    await complete(id, {
      nowMs,
      status: "failed",
      error: "TELEGRAM_BOT_TOKEN is missing - run: iva config",
    });
    fail(
      `reminders: ${id}: TELEGRAM_BOT_TOKEN is missing - run: iva config`,
      1,
    );
  }

  // Bearer напоминания читает сам ход: без него это провал хода (дословный текст с
  // причиной), а не провал процесса — сообщение всё равно должно уйти.
  const settlement = await settleReminder(row, {
    nowMs,
    token,
    tz: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    tr: await noticeTranslator(process.env),
    send: sendTelegramHtml,
    runTurn: (prompt) =>
      runReminderTurn(prompt, reminderClientOptions(process.env), { log }),
    log,
    dataDir: dataDir(),
    table: { complete, remove, release },
    nextCronRunMs,
    alert: { alertOnce, alertResolved },
  });

  console.log(`reminders: ${id} ${settlement}`);
  process.exit(settlement === "failed" ? 1 : 0);
}

main().catch((error: unknown) => {
  const id = process.argv[2] ?? "";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reminders: ${id}: ${message}`);
  process.exit(1);
});
