// Доставка одной арендованной строки и решение о её судьбе: повтор, снятие или пропуск
// срока. Здесь только правила и тексты; часы, транспорт и таблица приходят через deps,
// поэтому решения проверяются без сети и таймеров. Ошибки таблицы наружу не глушатся:
// их ловит точка входа процесса (scripts/reminders/deliver.ts).
import { formatZoned } from "#lib/zoned-time.ts";
import type {
  Reminder,
  complete,
  release,
  remove,
} from "#lib/reminder-store.ts";
import type { alertOnce, alertResolved } from "./notice-policy.ts";
import { reminderPrompt, type ReminderTurn } from "./reminder-turn.ts";
import type { sendTelegramHtml } from "./telegram-send.ts";

/** После провала строка не повторяется чаще, чем раз в пять минут. */
export const REMINDER_RETRY_INTERVAL_MS = 5 * 60_000;
/** Разовое напоминание: шесть часов попыток от срока, потом снимается. */
export const REMINDER_RETRY_WINDOW_AT_MS = 6 * 60 * 60_000;
/** Повторяющееся: тридцать минут, потом ждёт следующего срока. */
export const REMINDER_RETRY_WINDOW_CRON_MS = 30 * 60_000;
/** Доставка позже срока на пять минут и больше называется задержкой. */
export const REMINDER_LATE_MS = 5 * 60_000;
/** Один Alert на строку в час, каким бы ни был текст ошибки. */
export const REMINDER_ALERT_REPEAT_MS = 60 * 60_000;

/** Ключ срока: по нему повтор после крэша между отправкой и записью не шлёт второй раз. */
export function deliveredKeyOf(row: Reminder): string {
  return `${row.id}:${row.nextRunAtMs}`;
}

export type DeliveryTurn = "n/a" | "ok" | `fallback: ${string}`;

export type DeliveryOutcome =
  | {
      readonly status: "ok";
      readonly deliveredKey: string;
      readonly turn: DeliveryTurn;
      readonly duplicate: boolean;
    }
  | {
      readonly status: "failed";
      readonly stage: "turn-and-send" | "send";
      readonly turn: DeliveryTurn;
      readonly error: string;
    };

export interface DeliveryDeps {
  readonly nowMs: number;
  readonly token: string;
  readonly tz: string;
  readonly tr: (en: string, ru: string) => string;
  readonly send: typeof sendTelegramHtml;
  /** Ход агента; `verbatim` его не зовёт вовсе. */
  readonly runTurn: (prompt: string) => Promise<ReminderTurn>;
  readonly log: (...args: unknown[]) => void;
}

export type Settlement =
  | "delivered"
  | "duplicate"
  | "deferred"
  | "failed"
  | "dropped"
  | "skipped-occurrence";

export interface SettleDeps extends DeliveryDeps {
  readonly dataDir: string;
  readonly table: {
    readonly complete: typeof complete;
    readonly remove: typeof remove;
    readonly release: typeof release;
  };
  readonly nextCronRunMs: (expr: string, tz: string, afterMs: number) => number;
  readonly alert: {
    readonly alertOnce: typeof alertOnce;
    readonly alertResolved: typeof alertResolved;
  };
}

/** Первые 60 символов текста — столько, чтобы узнать напоминание, но не тащить его целиком. */
function shortText(row: Reminder): string {
  return row.text.slice(0, 60);
}

function failedAlertText(
  row: Reminder,
  deps: DeliveryDeps,
  error: string,
  windowMs: number,
): string {
  const deadline = formatZoned(row.nextRunAtMs + windowMs, deps.tz);
  return `⚠️ ${deps.tr(
    `Reminder «${shortText(row)}» still cannot be delivered: ${error}. I retry every 5 minutes until ${deadline}, then drop it. Check the chat settings or remove it: remind_remove ${row.id}.`,
    `Напоминание «${shortText(row)}» снова не доставлено: ${error}. Повторяю каждые 5 минут до ${deadline}, потом сниму. Проверь чат или сними его: remind_remove ${row.id}.`,
  )}`;
}

function droppedAtAlertText(
  row: Reminder,
  deps: DeliveryDeps,
  error: string,
  windowMs: number,
): string {
  const hours = Math.round(windowMs / 3_600_000);
  return `⚠️ ${deps.tr(
    `Reminder «${shortText(row)}» dropped after ${hours}h of failed attempts: ${error}. Text: ${row.text}`,
    `Напоминание «${shortText(row)}» снято после ${hours} ч неудачных попыток: ${error}. Текст: ${row.text}`,
  )}`;
}

function droppedCronAlertText(
  row: Reminder,
  deps: DeliveryDeps,
  error: string,
  windowMs: number,
  nextRunAtMs: number,
): string {
  const minutes = Math.round(windowMs / 60_000);
  const next = formatZoned(nextRunAtMs, deps.tz);
  return `⚠️ ${deps.tr(
    `Reminder «${shortText(row)}» missed its slot after ${minutes} min of failed attempts: ${error}. Next run: ${next}. Text: ${row.text}`,
    `Напоминание «${shortText(row)}» пропустило срок после ${minutes} мин неудачных попыток: ${error}. Следующий: ${next}. Текст: ${row.text}`,
  )}`;
}

interface TurnAttempt {
  readonly text: string;
  readonly turnLabel: DeliveryTurn;
  readonly turn: ReminderTurn | undefined;
}

/** Ход агента: текст хода либо дословный текст с причиной. Причина не теряется молча. */
async function attemptTurn(
  row: Reminder,
  deps: DeliveryDeps,
  scheduledAt: string | undefined,
): Promise<TurnAttempt> {
  let turn: ReminderTurn | undefined;
  let cause: string | undefined;
  try {
    turn = await deps.runTurn(reminderPrompt(row.text, deps.tr, scheduledAt));
    if (turn.status === "failed")
      cause = `status "failed"${turn.message === undefined ? "" : `: ${turn.message}`}`;
    else if (turn.message === undefined)
      cause = `no text (status "${turn.status}")`;
  } catch (error) {
    cause = error instanceof Error ? error.message : String(error);
  }

  if (cause === undefined && turn?.message !== undefined)
    return { text: turn.message, turnLabel: "ok", turn };

  const reason = cause ?? `no text (status "${turn?.status}")`;
  deps.log(`reminders: ${row.id} agent turn failed: ${reason}`);
  return {
    text: `⏰ ${row.text}\n\n${deps.tr(
      `(the agent turn did not run: ${reason})`,
      `(ход агента не выполнился: ${reason})`,
    )}`,
    turnLabel: `fallback: ${reason}`,
    turn,
  };
}

export async function deliverReminder(
  row: Reminder,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  if (row.deliver.threadId !== undefined)
    return {
      status: "failed",
      stage: "send",
      turn: "n/a",
      error: "thread delivery is not supported",
    };

  const deliveredKey = deliveredKeyOf(row);
  if (row.deliveredKey === deliveredKey)
    return { status: "ok", deliveredKey, turn: "n/a", duplicate: true };

  const late = deps.nowMs - row.nextRunAtMs > REMINDER_LATE_MS;
  const scheduledAt = formatZoned(row.nextRunAtMs, deps.tz);

  let text: string;
  let turnLabel: DeliveryTurn;
  let turn: ReminderTurn | undefined;
  if (row.mode === "verbatim") {
    turnLabel = "n/a";
    text = late
      ? `⏰ ${row.text}\n\n${deps.tr(
          `(set for ${scheduledAt}, delivered late)`,
          `(назначено на ${scheduledAt}, доставлено с задержкой)`,
        )}`
      : `⏰ ${row.text}`;
  } else {
    const attempt = await attemptTurn(
      row,
      deps,
      late ? scheduledAt : undefined,
    );
    text = attempt.text;
    turnLabel = attempt.turnLabel;
    turn = attempt.turn;
  }

  const result = await deps.send(deps.token, row.deliver.chatId, text, {
    retryTransient: true,
    trace: { source: "reminder" },
  });

  if (!result.ok)
    return {
      status: "failed",
      stage: turnLabel === "ok" ? "send" : "turn-and-send",
      turn: turnLabel,
      error: result.error,
    };

  if (turnLabel === "ok" && result.fellBack && turn !== undefined) {
    // Напоминание уже ушло: потерянная подсказка не имеет права уронить процесс.
    try {
      await turn.feedback(
        `The last reminder failed Telegram parse_mode=HTML (${result.error}) and was sent as plain text — ` +
          "format more simply next time: **bold**, `code`, lists, no raw HTML.",
      );
    } catch (error) {
      deps.log(`reminders: ${row.id} turn feedback failed:`, error);
    }
  }

  return { status: "ok", deliveredKey, turn: turnLabel, duplicate: false };
}

function retryWindowMs(row: Reminder): number {
  return row.schedule.kind === "at"
    ? REMINDER_RETRY_WINDOW_AT_MS
    : REMINDER_RETRY_WINDOW_CRON_MS;
}

export async function settleReminder(
  row: Reminder,
  deps: SettleDeps,
): Promise<Settlement> {
  const { id } = row;

  // 1. Троттлинг: провал был только что — отпустить строку и повторить на следующем тике.
  if (
    row.lastStatus === "failed" &&
    row.lastRunAtMs !== null &&
    deps.nowMs - row.lastRunAtMs < REMINDER_RETRY_INTERVAL_MS
  ) {
    await deps.table.release(id);
    deps.log(`reminders: ${id} retry not due`);
    return "deferred";
  }

  const windowMs = retryWindowMs(row);

  // 2. Окно повторов кончилось: разовое снимается, повторяющееся пропускает срок.
  if (row.lastStatus === "failed" && deps.nowMs - row.nextRunAtMs > windowMs) {
    const key = `reminder-${id}-dropped`;
    const error = row.lastError ?? "unknown";
    const alert = (text: string) =>
      deps.send(deps.token, row.deliver.chatId, text, {
        retryTransient: true,
        trace: { source: "reminder-alert" },
      });

    if (row.schedule.kind === "at") {
      await deps.table.remove(id);
      await deps.alert.alertOnce(
        deps.dataDir,
        key,
        id,
        async () =>
          (await alert(droppedAtAlertText(row, deps, error, windowMs))).ok,
        REMINDER_ALERT_REPEAT_MS,
      );
      deps.log(`reminders: ${id} dropped`);
      return "dropped";
    }

    const nextRunAtMs = deps.nextCronRunMs(
      row.schedule.expr,
      row.schedule.tz,
      deps.nowMs,
    );
    await deps.table.complete(id, {
      nowMs: deps.nowMs,
      status: "failed",
      error: `gave up on this occurrence: ${error}`,
      nextRunAtMs,
    });
    await deps.alert.alertOnce(
      deps.dataDir,
      key,
      id,
      async () =>
        (
          await alert(
            droppedCronAlertText(row, deps, error, windowMs, nextRunAtMs),
          )
        ).ok,
      REMINDER_ALERT_REPEAT_MS,
    );
    deps.log(
      `reminders: ${id} skipped-occurrence, next ${formatZoned(nextRunAtMs, deps.tz)}`,
    );
    return "skipped-occurrence";
  }

  // 3. Доставка.
  const outcome = await deliverReminder(row, deps);

  // 4. Успех: закрыть срок и забыть Alert. Повторяющееся получает следующий срок от now —
  // накопленный за простой хвост схлопывается в одну доставку.
  if (outcome.status === "ok") {
    if (row.schedule.kind === "at") {
      await deps.table.complete(id, {
        nowMs: deps.nowMs,
        status: "ok",
        deliveredKey: outcome.deliveredKey,
      });
    } else {
      await deps.table.complete(id, {
        nowMs: deps.nowMs,
        status: "ok",
        deliveredKey: outcome.deliveredKey,
        nextRunAtMs: deps.nextCronRunMs(
          row.schedule.expr,
          row.schedule.tz,
          deps.nowMs,
        ),
      });
    }
    deps.alert.alertResolved(deps.dataDir, `reminder-${id}`);
    deps.log(`reminders: ${id} delivered (turn ${outcome.turn})`);
    return outcome.duplicate ? "duplicate" : "delivered";
  }

  // 5. Провал: строка остаётся, статусы хода и отправки не смешиваются. Второй провал
  // подряд (и дальше) говорит владельцу, что делать.
  const error = `${outcome.stage}: ${outcome.error} (turn ${outcome.turn})`;
  await deps.table.complete(id, {
    nowMs: deps.nowMs,
    status: "failed",
    error,
  });
  deps.log(`reminders: ${id} failed: ${error}`);
  if (row.lastStatus === "failed") {
    await deps.alert.alertOnce(
      deps.dataDir,
      `reminder-${id}`,
      id,
      async () =>
        (
          await deps.send(
            deps.token,
            row.deliver.chatId,
            failedAlertText(row, deps, outcome.error, windowMs),
            { retryTransient: true, trace: { source: "reminder-alert" } },
          )
        ).ok,
      REMINDER_ALERT_REPEAT_MS,
    );
  }
  return "failed";
}
