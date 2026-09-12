import { defineTool } from "eve/tools";
import { z } from "zod";
import { remove } from "../lib/reminder-store.ts";
import { toolFailure } from "../lib/reminder-tool.ts";

export type RemindRemoveAnswer =
  | {
      readonly ok: true;
      readonly removed: { readonly id: string; readonly text: string };
    }
  | { readonly ok: false; readonly error: string };

export default defineTool({
  description:
    "Снять напоминание по id (см. remind_list). Повторяющееся снимается целиком. " +
    "Нет такого id - инструмент вернёт ошибку; не выдумывай id, сперва посмотри remind_list.",
  inputSchema: z.object({
    id: z.string().min(1).describe("id из remind_list"),
  }),
  async execute({ id }): Promise<RemindRemoveAnswer> {
    try {
      const row = await remove(id);
      return { ok: true as const, removed: { id: row.id, text: row.text } };
    } catch (error) {
      return toolFailure(error);
    }
  },
});
