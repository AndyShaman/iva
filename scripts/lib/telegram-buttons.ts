// Rich-кнопки Telegram: кнопка — inline-элемент markdown-текста rich message, а не ряд
// коротких подписей под сообщением (Bot API 24.08.2026, контракт волны — rich-common.md).
// Экран собирает markdown сам и вставляет в него готовые строки отсюда: одно место, где
// живёт синтаксис тега, для моста, меню и визардов.
//
// Контракт: <tg-button type="callback_data" data="…" style="…">подпись</tg-button> стоит
// ПРЯМО в строке рядом с пояснением («кнопка — что она делает»); <tg-button-row> — только
// для равноправных коротких вариантов (да/нет, список). Нажатие приходит обычным
// callback_query с тем же data, поэтому обработчики кнопок не меняются.

export type RichButtonStyle = "danger" | "success" | "link";

const STYLES: readonly RichButtonStyle[] = ["danger", "success", "link"];

function isRichButtonStyle(value: unknown): value is RichButtonStyle {
  return STYLES.includes(value as RichButtonStyle);
}

/**
 * Переходный тип: rich-строка (тег кнопки или абзац «кнопка — пояснение»), которая пока
 * обязана проходить и в старый ряд «{text, callback_data}», и в markdown-текст экрана.
 * Ряды снимет D3 — вместе с ними уйдут и richRow/legacyRows, и этот бренд.
 */
export type RichButton = string & {
  text: string;
  callback_data: string;
  style?: RichButtonStyle;
  [key: string]: unknown;
};

/** Старый ряд кнопок: то, что экраны отдают движку до перехода на rich (см. legacyRows). */
export type LegacyButton = {
  text: string;
  callback_data: string;
  style?: RichButtonStyle;
};

/** Что legacyRows принимает в переходный период: старый ряд, готовую rich-строку или
 *  ряд, который экран уже собрал из rich-строк (Row из record'ов — самый частый случай). */
type LegacyRowsInput = ReadonlyArray<
  | ReadonlyArray<LegacyButton | string>
  | string
  | ReadonlyArray<Record<string, unknown>>
>;

/** data — ASCII-энум (грамматика iva_menu://iva_model://iva_think://iva_update:), но кавычка
 *  или угловая скобка сломали бы сам тег: атрибут экранируется, это защита в глубину. */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Кнопка rich-сообщения. `style` необязателен: danger | success | link.
 * Возвращаемое значение — markdown-строка; поставь её в текст экрана в строку с пояснением.
 */
export function button(
  text: string,
  callbackData: string,
  style?: RichButtonStyle,
): RichButton {
  const styled = style ? ` style="${style}"` : "";
  return `<tg-button type="callback_data"${styled} data="${attribute(callbackData)}">${text}</tg-button>` as unknown as RichButton;
}

/** Ряд равноправных кнопок (до 8): только там, где у каждой нет своего пояснения. */
export function buttonRow(buttons: readonly string[]): string {
  return `<tg-button-row>${buttons.join("")}</tg-button-row>`;
}

/**
 * Экранирование данных пользователя для rich markdown: путь, имя модели, ключ. Эти
 * символы rich-разметка читает как разметку: `<` ломает ещё и тег, `*`/`_`/`#`/`|` —
 * абзац. Подписи кнопок внутри тега не экранируются — их пишет сам экран.
 */
export function escapeRichText(s: string): string {
  return s.replace(/([*_#|<])/g, "\\$1");
}

/**
 * Кнопка в строке текста (RichTextButton) на Android-клиентах лета 2026 рисуется криво:
 * подпись уезжает под пилюлю (скриншот пользователя 13.09.2026). Ряд-блок
 * (<tg-button-row>, RichBlockButtons) рендерится всеми клиентами одинаково, поэтому перед
 * отправкой каждая строка вида «<tg-button…>Подпись</tg-button> — пояснение» становится
 * рядом-блоком из одной кнопки на всю ширину и абзацем пояснения под ним. Строки, где
 * кнопка стоит не первой или их несколько, не трогаем. Решение владельца 13.09.2026.
 */
export function blockButtons(markdown: string): string {
  return markdown.replace(
    /^(<tg-button(?=[\s>])[^>]*>[\s\S]*?<\/tg-button>)[ \t]*(?:[—–-][ \t]*)?(.*)$/gm,
    (_m, tag: string, rest: string) =>
      rest.trim() ? `${buttonRow([tag])}\n${rest.trim()}` : buttonRow([tag]),
  );
}

/**
 * Переходный помощник для ряда, который уже состоит из готовых rich-строк (тегов кнопок
 * или абзацев «кнопка — пояснение»): старые экраны собирают такие ряды руками.
 * D3 перепишет экраны — помощник уйдёт вместе с рядами.
 */
export function richRow(...fragments: string[]): RichButton[] {
  return fragments as unknown as RichButton[];
}

/**
 * Переходный шим: старый ряд «{text, callback_data}[]» → rich-строки для текста сообщения.
 * Ряд из одного элемента (в т.ч. абзац «кнопка — пояснение» из richRow) встаёт своей
 * строкой, ряд из нескольких — <tg-button-row> (равноправные варианты старой раскладки).
 * Значения проверяются по typeof: в переходный период в ряду рядом со старым объектом
 * лежит готовая rich-строка (RichButton). D3 снимет ряды вместе с этим шимом.
 */
export function legacyRows(rows: LegacyRowsInput | null | undefined): string {
  if (!rows || !Array.isArray(rows)) return "";
  const lines: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      lines.push(row); // готовая строка (richRow), а не ряд
      continue;
    }
    if (!Array.isArray(row)) continue;
    const buttons = row
      .map(toRichButton)
      .filter((value): value is string => value !== null);
    if (buttons.length === 0) continue;
    lines.push(buttons.length === 1 ? buttons[0] : buttonRow(buttons));
  }
  return lines.join("\n");
}

function toRichButton(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const { text, callback_data, style } = item as {
    text?: unknown;
    callback_data?: unknown;
    style?: unknown;
  };
  if (typeof text !== "string" || typeof callback_data !== "string")
    return null;
  return button(
    text,
    callback_data,
    isRichButtonStyle(style) ? style : undefined,
  );
}
