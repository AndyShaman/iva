/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Карта agent/instructions.md уходит в system каждого шага модели, и ADR-0014 держит её в
// пределах 5 000 знаков. Правила, которые владелец назвал приоритетом 10.10.2026 («сначала
// ищи сама, потом спрашивай», длинный вывод в файл), держатся якорями: сокращение карты под
// предел не выбрасывает их молча. Лежит в scripts/, а не в agent/instructions/: там eve
// принял бы файл за инструкцию.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MAP = read("agent/instructions.md");
/** Тот же текст одной строкой: перенос строк в markdown смысла не меняет. */
const FLAT_MAP = MAP.replace(/\s+/gu, " ");
/** ADR-0014: предел карты в знаках (владелец, 22.09.2026). */
const MAP_LIMIT = 5_000;

/** Пункт списка карты `- **<title>…` до следующего пункта или раздела, одной строкой. */
function item(title: string): string {
  const start = MAP.indexOf(`- **${title}`);
  assert.notEqual(start, -1, `в карте нет пункта «${title}»`);
  const rest = MAP.slice(start + 2);
  const end = rest.search(/\n(?:- |\n)/u);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/gu, " ");
}

test("the map stays within 5 000 characters (ADR-0014)", () => {
  const length = Array.from(MAP).length;
  assert.ok(
    length <= MAP_LIMIT,
    `agent/instructions.md: ${length} знаков, предел ${MAP_LIMIT}`,
  );
});

test("before a question to the owner the map walks memory, tools and skills, the web, the browser, the server — in that order", () => {
  const rule = item("Find it yourself before you ask");
  let from = 0;
  for (const step of [
    "memory_search",
    "skill",
    "web",
    "browser",
    "`bash`",
    "Ask the owner",
  ]) {
    const at = rule.indexOf(step, from);
    assert.ok(at >= from, `«${step}» выпал из порядка поиска: ${rule}`);
    from = at + step.length;
  }
  assert.match(rule, /say what you checked/u);
  assert.match(rule, /skill library/u);
  // Перегиб в другую сторону: выбор и согласие остаются вопросом владельцу.
  assert.match(rule, /Choices, consent/u);
});

test("long output goes to a file and is read in parts", () => {
  const rule = item("Long output");
  assert.match(rule, /to a file/u);
  assert.match(rule, /read it in parts/u);
});

// В фоновом ходе (Watch, Brief, Insight, Reminder) код доставляет текст хода сам: фраза «что
// делаю» там стала бы сообщением владельцу, поэтому правило — только для разговора в чате.
test("the one sentence before a chain of tools is for a chat only", () => {
  assert.match(
    FLAT_MAP,
    /In a chat, before a long chain of tools, say in one short sentence what you are doing\./u,
  );
});

test("the ephemeral goes to todo, tasks or a Reminder, not CORE", () => {
  const memoryMap = read("agent/instructions/10-map.md").replace(/\s+/gu, " ");
  assert.match(
    memoryMap,
    /Do NOT write the ephemeral into CORE[^.]*`todo`[^.]*`tasks` or a Reminder/u,
  );
});
