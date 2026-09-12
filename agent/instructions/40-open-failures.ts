// Каждый ход: незакрытые провалы расписаний и напоминаний за сутки (T20 п.3).
// Динамическая инструкция, как 30-owner-rules.ts: читает data/jobs.json и таблицу
// напоминаний на turn.started. Нет провалов — пустая строка, ничего не стоит.
import { defineDynamic, defineInstructions } from "eve/instructions";
import { openFailures, openFailuresMarkdown } from "../lib/open-failures.ts";

export { openFailuresMarkdown } from "../lib/open-failures.ts";

export default defineDynamic({
  events: {
    "turn.started": async () => {
      const failures = await openFailures();
      return defineInstructions({ markdown: openFailuresMarkdown(failures) });
    },
  },
});
