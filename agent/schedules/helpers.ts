import { defineSchedule } from "eve/schedules";
import { REMINDER_TICK_CRON } from "../lib/schedule-table.js";
import { runHelperTick } from "../lib/helper-tick.js";
export default defineSchedule({
  cron: REMINDER_TICK_CRON,
  run: ({ waitUntil }) => waitUntil(runHelperTick()),
});
