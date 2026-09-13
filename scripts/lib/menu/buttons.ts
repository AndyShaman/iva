// Локальный помощник rich-кнопок для экранов меню и мастеров: в rich message кнопка —
// inline-элемент markdown, а не ячейка inline-клавиатуры, поэтому экран собирает её
// строкой прямо в тексте, рядом с пояснением. Мост уже умеет rich (tg-flow/transport),
// а общий помощник scripts/lib/telegram-buttons.ts появится параллельной правкой — этот
// файл живёт, пока экраны не перейдут на него, и умирает вместе с контрактом «текст + ряды».

export type RichButtonStyle = "danger" | "success" | "link";

// data — ASCII 1-64 байта (грамматика callback_data из menu/index.ts). Подпись внутри
// тега — не markdown: экранировать её не нужно и нельзя (слэши попадут в подпись).
export function button(
  text: string,
  data: string,
  style?: RichButtonStyle,
): string {
  const styleAttr = style ? ` style="${style}"` : "";
  return `<tg-button type="callback_data"${styleAttr} data="${data}">${text}</tg-button>`;
}

// Ряд — только для равноправных коротких вариантов без пояснений: да/нет, ответы квиза,
// список моделей. Всё остальное — «кнопка — что она делает» отдельным абзацем.
export function buttonRow(buttons: string[]): string {
  return `<tg-button-row>${buttons.join("")}</tg-button-row>`;
}

// Спецсимволы markdown в данных пользователя (имена моделей, ключи, пути, тексты
// напоминаний) ломают разметку и открывают теги: `* _ # | <` экранируются обратным слэшем.
export function escapeRichText(value: unknown): string {
  return String(value).replace(/([*_#|<>])/g, "\\$1");
}
