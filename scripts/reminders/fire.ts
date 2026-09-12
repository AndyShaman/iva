// Срабатывание одного напоминания:
//   node --env-file-if-exists=.env scripts/reminders/fire.ts <id>
// Запускает её минутный тик (agent/lib/reminder-tick.ts) на строке, которую уже перевёл в
// fired. Две ветки идут ОДНОВРЕМЕННО и друг друга не ждут:
//   (а) текст владельцу как есть через sendTelegramHtml — работает без модели и её токенов;
//   (б) агент просыпается ходом-проверкой: доставлен ли текст, и если нет — говорит сам.
// Обе только дописывают факт в ту же строку (delivered/error), строку не закрывают и ничего
// не повторяют: повторов у напоминаний нет по решению владельца 12.09. Если процесс упал, не
// сказав факта, тик запишет delivered=false с причиной по коду выхода.
//
// Живёт в scripts/, а не в agent/: выталкивание наружу идёт через Telegram и клиента eve
// (scripts/authored-tree-guard.test.ts: agent/ не импортирует scripts/).
// Коды выхода: 0 — обе ветки отработали; 2 — вызов без id или неизвестный id.
import { isEntrypoint } from "../lib/version-layout.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  list,
  recordDelivery,
  recordWakeError,
  type Reminder,
} from "#lib/reminder-store.ts";
import { resolveTimeZone } from "#lib/timezone.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import {
  firePrompt,
  reminderClientOptions,
  runReminderTurn,
  type ReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

/** Сколько ветка агента ждёт факт отправки, прежде чем сказать своё: иначе был бы дубль. */
export const AGENT_DECISION_GRACE_MS = 10_000;

const USAGE = "usage: fire.ts <reminder id>";

export type ReminderFireDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly list?: typeof list;
  readonly recordDelivery?: typeof recordDelivery;
  readonly recordWakeError?: typeof recordWakeError;
  readonly send?: typeof sendTelegramHtml;
  readonly runTurn?: typeof runReminderTurn;
  readonly chat?: (env: NodeJS.ProcessEnv) => string | null;
  readonly translator?: typeof noticeTranslator;
  readonly log?: (...args: unknown[]) => void;
  readonly sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Однo срабатывание. Возвращает код выхода вместо process.exit: так его проверяет тест, а
 * точку входа закрывает нижний `isEntrypoint`.
 */
export async function runReminderFire(
  id: string,
  dependencies: ReminderFireDependencies = {},
): Promise<number> {
  if (id.trim() === "") {
    console.error(USAGE);
    return 2;
  }
  const env = dependencies.env ?? process.env;
  const read = dependencies.list ?? list;
  const record = dependencies.recordDelivery ?? recordDelivery;
  const recordError = dependencies.recordWakeError ?? recordWakeError;
  const send = dependencies.send ?? sendTelegramHtml;
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const sleep = dependencies.sleep ?? realSleep;

  let row: Reminder | undefined;
  try {
    row = (await read()).find((candidate) => candidate.id === id);
  } catch (error) {
    console.error(`reminders: ${id}: ${message(error)}`);
    return 1;
  }
  if (row === undefined) {
    console.error(`reminders: ${id}: unknown id`);
    return 2;
  }

  const tz = resolveTimeZone(env.ASSISTANT_TIMEZONE);
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = (dependencies.chat ?? notificationChat)(env);
  const tr = await (dependencies.translator ?? noticeTranslator)(env);

  // Ветка (а): текст владельцу как есть. Не глядит ни на модель, ни на вторую ветку.
  const deliver = async (): Promise<void> => {
    if (token === "" || chat === null) {
      const reason =
        token === ""
          ? "TELEGRAM_BOT_TOKEN is missing - run: iva config"
          : "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS";
      await record(id, { delivered: false, error: reason });
      log(`reminders: ${id} not delivered: ${reason}`);
      return;
    }
    const result = await send(token, chat, row.text, {
      retryTransient: true,
      trace: { source: "reminder" },
    });
    await record(id, {
      delivered: result.ok,
      error: result.ok ? null : result.error,
    });
    log(
      result.ok
        ? `reminders: ${id} delivered`
        : `reminders: ${id} not delivered: ${result.error}`,
    );
  };

  // Ветка (б): ход агента. Своё сообщение отправляет только тогда, когда факт доставки уже
  // известен и текст не дошёл: иначе агент продублировал бы работу кода.
  const wake = async (delivered: Promise<void>): Promise<void> => {
    let turn: ReminderTurn;
    try {
      turn = await (dependencies.runTurn ?? runReminderTurn)(
        firePrompt(
          {
            id,
            text: row.text,
            scheduledAt: formatZoned(row.firedAt ?? row.nextRunAtMs, tz),
          },
          tr,
        ),
        reminderClientOptions(env),
        { log },
      );
    } catch (error) {
      const reason = `agent wake failed: ${message(error)}`;
      await recordError(id, reason);
      log(`reminders: ${id} ${reason}`);
      return;
    }
    if (turn.status === "failed") {
      const reason = `agent turn failed: ${turn.message ?? "unknown"}`;
      await recordError(id, reason);
      log(`reminders: ${id} ${reason}`);
      return;
    }
    const reply = turn.message?.trim() ?? "";
    if (reply === "") {
      log(`reminders: ${id} agent woke, nothing to say`);
      return;
    }
    if (token === "" || chat === null) {
      const reason = "agent message not sent: no bot token or owner chat";
      await recordError(id, reason);
      log(`reminders: ${id} ${reason}`);
      return;
    }
    // Факт отправки может прийти позже хода: ждём его не дольше десяти секунд.
    await Promise.race([delivered, sleep(AGENT_DECISION_GRACE_MS)]);
    const after = (await read()).find((candidate) => candidate.id === id);
    if (after?.delivered === true) {
      log(`reminders: ${id} agent woke, text already delivered`);
      return;
    }
    const result = await send(token, chat, reply, {
      retryTransient: true,
      trace: { source: "reminder" },
    });
    if (!result.ok) {
      const reason = `agent message not delivered: ${result.error}`;
      await recordError(id, reason);
      log(`reminders: ${id} ${reason}`);
      return;
    }
    log(`reminders: ${id} agent sent its own message`);
  };

  const delivered = deliver();
  const woken = wake(delivered);
  const outcomes = await Promise.allSettled([delivered, woken]);
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected")
      log(
        `reminders: ${id} ${index === 0 ? "delivery" : "wake"} branch threw: ${message(outcome.reason)}`,
      );
  });
  return 0;
}

if (isEntrypoint(import.meta.url))
  process.exit(await runReminderFire(process.argv[2] ?? ""));
