import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerTimeZone } from "../lib/reminder-time.ts";
import { list } from "../lib/reminder-store.ts";
import {
  describeReminder,
  schedulerStatus,
  toolFailure,
  type ReminderView,
  type SchedulerStatus,
} from "../lib/reminder-tool.ts";
import { formatZoned } from "../lib/zoned-time.ts";

export type RemindListAnswer =
  | {
      readonly ok: true;
      readonly count: number;
      readonly now: string;
      readonly timezone: string;
      readonly reminders: readonly ReminderView[];
      readonly scheduler: SchedulerStatus;
    }
  | { readonly ok: false; readonly error: string };

export default defineTool({
  description:
    "Показать поставленные напоминания: id, текст, следующий срок next_run_at в зоне " +
    "пользователя и факт последнего срабатывания (fired_at, delivered, error). Недавно сработавшие " +
    "видны сутки. Время не пересчитывай, показывай как вернул инструмент. " +
    "Если scheduler.alive = false, предупреди пользователя: напоминания записаны, но сейчас не сработают.",
  inputSchema: z.object({}),
  async execute(): Promise<RemindListAnswer> {
    const tz = ownerTimeZone();
    const nowMs = Date.now();
    try {
      const rows = await list();
      return {
        ok: true as const,
        count: rows.length,
        now: formatZoned(nowMs, tz),
        timezone: tz,
        reminders: rows.map((row) => describeReminder(row, tz)),
        scheduler: schedulerStatus(nowMs, tz),
      };
    } catch (error) {
      return toolFailure(error);
    }
  },
});
