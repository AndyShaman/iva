// Rich-кнопки Telegram: кнопка — inline-элемент markdown-текста rich message, а не ряд
// коротких подписей под сообщением (Bot API 24.08.2026, контракт волны — rich-common.md).
// Экран собирает markdown сам и вставляет в него готовые строки отсюда: одно место, где
// живёт синтаксис тега, для моста, меню и визардов.
//
// Контракт: <tg-button type="callback_data" data="…" style="…">подпись</tg-button> стоит
// ПРЯМО в строке рядом с пояснением («кнопка — что она делает»); <tg-button-row> — только
// для равноправных коротких вариантов (да/нет, список). Нажатие приходит обычным
// callback_query с тем же data, поэтому обработчики кнопок не меняются.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDirSetting } from "../../packages/data-dir/index.ts";

export type RichButtonStyle = "danger" | "success" | "link";

/**
 * Стиль меню (решение владельца 13.09.2026): по умолчанию «classic» — обычное сообщение
 * с inline-клавиатурой под ним, как до 0.4.2; «rich» — кнопки внутри rich message.
 * Переключается в /menu → Обслуживание («✨ Новое меню» / «◀︎ Старое меню»), живёт в
 * settings.json, читается свежим на каждую отрисовку — обоим процессам видно сразу.
 */
export type MenuStyle = "classic" | "rich";

// Читаем settings.json сами (без #lib/settings.ts): этот модуль грузится и в CLI, а CLI
// обязан подниматься без authored tree (см. authored-tree-guard). Ошибка чтения = classic.
export function menuStyle(): MenuStyle {
  try {
    const dir = resolve(dataDirSetting(process.env.ASSISTANT_DATA_DIR));
    const raw = JSON.parse(
      readFileSync(join(dir, "settings.json"), "utf8"),
    ) as {
      menuStyle?: unknown;
    };
    return raw.menuStyle === "rich" ? "rich" : "classic";
  } catch {
    return "classic";
  }
}

export type ClassicScreen = {
  text: string;
  reply_markup?: { inline_keyboard: ClassicButton[][] };
};
export type ClassicButton = {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  style?: "danger" | "success" | "primary";
};

/**
 * Один экран в обоих стилях. Экраны пишут rich markdown с кнопками в тексте; для classic
 * тот же текст разбирается на подпись+клавиатуру: строка с кнопкой становится рядом
 * клавиатуры (пояснение после «—» уходит в текст строкой), <tg-button-row> — рядом из
 * нескольких, заголовок теряет «#», таблица становится строками «a — b», экранирование
 * снимается. Так у экранов один источник, а у пользователя выбор.
 */
export function screenPayload(
  markdown: string,
): { rich_message: { markdown: string } } | ClassicScreen {
  return menuStyle() === "rich"
    ? { rich_message: { markdown: blockButtons(markdown) } }
    : classicScreen(markdown);
}

const BUTTON_RE = /<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>/gi;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return m
    ? m[1]
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
    : undefined;
}

function classicButton(attrs: string, label: string): ClassicButton | null {
  const text = label.replace(/<[^>]+>/g, "").trim();
  if (!text) return null;
  const type = attr(attrs, "type");
  const style = attr(attrs, "style");
  const styled: Pick<ClassicButton, "style"> =
    style === "danger" || style === "success" ? { style } : {};
  const data = attr(attrs, "data");
  const url = attr(attrs, "url");
  const copy = attr(attrs, "text");
  if (type === "url" && url) return { text, url, ...styled };
  if (type === "copy_text" && copy)
    return { text, copy_text: { text: copy }, ...styled };
  if (data) return { text, callback_data: data, ...styled };
  return null;
}

function classicLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trimEnd();
}

export function classicScreen(markdown: string): ClassicScreen {
  const rows: ClassicButton[][] = [];
  const text: string[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) {
      text.push("");
      continue;
    }
    if (/^<tg-button-row\b/i.test(line)) {
      const row = [...line.matchAll(BUTTON_RE)]
        .map((m) => classicButton(m[1], m[2]))
        .filter((b): b is ClassicButton => b !== null);
      if (row.length) rows.push(row);
      continue;
    }
    if (/^<tg-button(?=[\s>])/i.test(line)) {
      const buttons = [...line.matchAll(BUTTON_RE)]
        .map((m) => classicButton(m[1], m[2]))
        .filter((b): b is ClassicButton => b !== null);
      for (const b of buttons) rows.push([b]);
      const rest = classicLine(line.replace(BUTTON_RE, "")).replace(
        /^\s*[—–-]\s*/,
        "",
      );
      if (rest && buttons.length === 1)
        text.push(`${buttons[0].text} — ${rest}`);
      else if (rest) text.push(rest);
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      if (/^[|\-: \t]+$/.test(line)) continue;
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => classicLine(c.trim()));
      text.push(cells.filter(Boolean).join(" — "));
      continue;
    }
    text.push(classicLine(line));
  }
  const body = text
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return rows.length
    ? { text: body, reply_markup: { inline_keyboard: rows } }
    : { text: body };
}

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
