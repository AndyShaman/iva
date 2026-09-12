import { randomBytes } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  nextCronRunMs,
  ownerTimeZone,
  resolveAt,
} from "../lib/reminder-time.ts";
import {
  add,
  normalizeSchedule,
  type Reminder,
} from "../lib/reminder-store.ts";
import {
  describeReminder,
  schedulerStatus,
  toolFailure,
  type ReminderView,
  type SchedulerStatus,
} from "../lib/reminder-tool.ts";
import { formatZoned } from "../lib/zoned-time.ts";

export type RemindAddAnswer =
  | {
      readonly ok: true;
      readonly reminder: ReminderView;
      readonly now: string;
      readonly scheduler: SchedulerStatus;
    }
  | { readonly ok: false; readonly error: string };

export default defineTool({
  description:
    "Поставить напоминание пользователю. Ровно одно из: at (разовое) или cron (повторяющееся). " +
    'Задай время словами пользователя или ISO в его зоне ("in 30m", "14:30", "2026-09-14 09:00"): ' +
    "не считай абсолютный момент сам и не конвертируй в UTC - время считает планировщик и возвращает " +
    "next_run_at, который и сообщи пользователю. " +
    "Адрес доставки указывать не нужно: напоминание всегда приходит в чат владельца. " +
    "Никогда не ставь таймер шеллом: systemd-run, crontab, at, sleep-циклы, свой скрипт с curl " +
    "запрещены и заблокированы - всё планирование только через этот инструмент. Если в ответе " +
    "scheduler.alive = false, скажи пользователю, что напоминание записано, но диспетчер сейчас не работает.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe("Что напомнить, дословно словами пользователя"),
    at: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Разовое: "in 30m", "in 1h 30m", "14:30", "2026-09-14 09:00" (в зоне пользователя) или ISO-момент со смещением',
      ),
    cron: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Повторяющееся: cron-выражение из 5 полей в зоне пользователя, например "0 9 * * 1-5"',
      ),
    mode: z
      .enum(["verbatim", "agent"])
      .optional()
      .describe(
        "verbatim (по умолчанию) - отправить текст как есть; agent - в назначенное время ты сверишься с задачами и сформулируешь сообщение сам",
      ),
  }),
  async execute({ text, at, cron, mode }): Promise<RemindAddAnswer> {
    if ((at === undefined) === (cron === undefined))
      return { ok: false as const, error: "give exactly one of at or cron" };
    const tz = ownerTimeZone();
    const chatId = notificationChat(process.env);
    if (!chatId)
      return {
        ok: false as const,
        error:
          "no owner chat: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS",
      };
    const nowMs = Date.now();
    const id = `r-${randomBytes(3).toString("hex")}`;
    const deliveryMode = mode ?? "verbatim";
    const answer = (row: Reminder) => ({
      ok: true as const,
      reminder: describeReminder(row, tz),
      now: formatZoned(nowMs, tz),
      scheduler: schedulerStatus(nowMs, tz),
    });
    try {
      if (at !== undefined) {
        const row = await add({
          id,
          text,
          mode: deliveryMode,
          schedule: { kind: "at", atMs: resolveAt(at, nowMs, tz) },
          deliver: { chatId },
        });
        return answer(row);
      }
      const schedule = normalizeSchedule({ kind: "cron", expr: cron, tz });
      if (schedule.kind !== "cron")
        return toolFailure(new Error("schedule: not a cron expression"));
      const row = await add({
        id,
        text,
        mode: deliveryMode,
        schedule,
        nextRunAtMs: nextCronRunMs(schedule.expr, tz, nowMs),
        deliver: { chatId },
      });
      return answer(row);
    } catch (error) {
      return toolFailure(error);
    }
  },
});
