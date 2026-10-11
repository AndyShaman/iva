import { defineHook } from "eve/hooks";
// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/lib/telegram-inbound.ts).
import { appendDaily } from "../lib/vault-daily.js";

// Канал чата владельца, как его называет eve (так же в agent/hooks/trace.ts). Сессию, которую
// открыл скрипт или плановый ход через API, eve помечает `http`, дочернюю — `subagent`: их
// финальный текст владелец не получал, в день он не пишется.
const TELEGRAM_CHANNEL_KIND = "channel:telegram";

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event, ctx) => {
      if (ctx.channel?.kind !== TELEGRAM_CHANNEL_KIND) return;
      if (event.data.finishReason === "tool-calls") return;
      const text = (event.data.message ?? "").trim();
      // QUIET — ответ планового хода Watch или Brief «писать не о чем»: в чат он не уходит
      // и в дневной файл не пишется (ADR-0020).
      if (!text || text === "QUIET") return;
      appendDaily("[iva]", text);
    },
  },
});
