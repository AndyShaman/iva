// Фраза модели по ходу работы встаёт в статус хода: лоадер, фраза, ⏹ — одним
// editMessageText на месте (решение владельца 10.10.2026). Здесь провод правки, враждебный
// текст, частота правок и конец хода; проводку канала держит
// scripts/telegram-status-progress.test.ts.
//
// Seed генератора печатается в имени теста: падение воспроизводится запуском с
// IVA_TEST_SEED=<seed>.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";

// Статус живёт в run-status, язык — в settings: оба читают ASSISTANT_DATA_DIR на загрузке.
const dataDir = mkdtempSync(join(tmpdir(), "iva-status-progress-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
writeFileSync(join(dataDir, "settings.json"), JSON.stringify({}));
process.env.AGENT_LANGUAGE = "en";
const load = <T>(name: string): Promise<T> =>
  import(
    pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href
  ) as Promise<T>;
const status = await load<typeof import("./telegram-status-message.ts")>(
  "./telegram-status-message.ts",
);
const runStatus =
  await load<typeof import("./run-status.ts")>("./run-status.ts");

const SEED = Number(process.env.IVA_TEST_SEED ?? 20261010) >>> 0 || 1;
const RUNS = 300;

const LOADER = '<tg-emoji emoji-id="5818797194127346654">💬</tg-emoji>';
const STOP_BUTTON =
  '<tg-button type="callback_data" style="danger" data="iva_cancel">⏹</tg-button>';
// Ключ той формы, что выдаёт провайдер; значение выдумано.
const KEY = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;

type Call = { method: string; body: Record<string, unknown> };
type Reply = { ok: boolean; body: unknown };

const markdownOf = (call: Call): string =>
  String(
    (call.body.rich_message as { markdown?: unknown } | undefined)?.markdown,
  );

function handle(
  chatId: string,
  reply: (call: Call) => Reply | Promise<Reply> = () => ({
    ok: true,
    body: { result: true },
  }),
  chatType?: string,
) {
  const calls: Call[] = [];
  return {
    calls,
    tg: {
      chatId,
      ...(chatType === undefined ? {} : { chatType }),
      request: (method: string, body?: Record<string, unknown>) => {
        const call = { method, body: body ?? {} };
        calls.push(call);
        return Promise.resolve(reply(call));
      },
    },
  };
}

// Живой ход сессии с отправленным статусом — так его оставляет turn.started.
function startTurn(chatId: string, sessionId: string, messageId?: number) {
  runStatus.setChatStatus(runStatus.chatKeyOf(chatId), {
    status: "running",
    sessionId,
    turnId: `turn-${sessionId}`,
    statusMessageId: messageId ?? null,
  });
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// Восемь знаков ключа в чате — уже утечка: голова ключа его и выдаёт.
function survivingChunk(text: string, body: string): string | null {
  for (let start = 0; start + 8 <= body.length; start++) {
    const chunk = body.slice(start, start + 8);
    if (text.includes(chunk)) return chunk;
  }
  return null;
}

// Видимый текст фразы: экранирующая косая перед знаком в чат не попадает.
const visible = (phrase: string) => phrase.replace(/\\(.)/gu, "$1");

await test("фраза модели правит статус на месте: лоадер, фраза, кнопка — один editMessageText", async () => {
  startTurn("101", "s-101", 500);
  const { calls, tg } = handle("101");

  await status.showTurnProgress(
    tg,
    "s-101",
    "Собираю черновики: суммы и реквизиты оставлю пустыми полями. Минуту.",
  );

  assert.deepEqual(calls, [
    {
      method: "editMessageText",
      body: {
        chat_id: "101",
        message_id: 500,
        rich_message: {
          markdown: `${LOADER} Собираю черновики: суммы и реквизиты оставлю пустыми полями. Минуту. ${STOP_BUTTON}`,
        },
      },
    },
  ]);
});

await test("в группе фраза есть, а кнопки нет — правило кнопки прежнее", async () => {
  startTurn("-1001", "s-group", 600);
  const { calls, tg } = handle("-1001", undefined, "supergroup");

  await status.showTurnProgress(tg, "s-group", "Ищу в почте");

  assert.equal(calls.length, 1);
  assert.equal(markdownOf(calls[0]), `${LOADER} Ищу в почте`);
});

await test("секрет вырезан гейтом до обрезки: ни куска ключа в правке", async () => {
  startTurn("102", "s-102", 501);
  const near = handle("102");
  await status.showTurnProgress(near.tg, "s-102", `Беру ключ ${KEY} из .env`);
  assert.equal(survivingChunk(JSON.stringify(near.calls), KEY), null);
  assert.match(markdownOf(near.calls[0]), /\\\[REDACTED\\\]/u);

  // Ключ на границе обрезки: резать раньше гейта — значит отдать голову ключа в чат.
  startTurn("103", "s-103", 502);
  const edge = handle("103");
  const head = "ш".repeat(status.STATUS_PHRASE_MAX_CHARS - 12);
  await status.showTurnProgress(edge.tg, "s-103", `${head} ${KEY}`);
  assert.equal(edge.calls.length, 1);
  assert.equal(survivingChunk(JSON.stringify(edge.calls), KEY), null);
});

await test("длинный многострочный текст — одна строка не длиннее STATUS_PHRASE_MAX_CHARS, с «…»", async () => {
  startTurn("104", "s-104", 503);
  const { calls, tg } = handle("104");
  const text = Array.from(
    { length: 200 },
    (_, i) => `строка ${i} с текстом`,
  ).join("\n");

  await status.showTurnProgress(tg, "s-104", text);

  const markdown = markdownOf(calls[0]);
  assert.ok(markdown.startsWith(`${LOADER} строка 0 с текстом строка 1`));
  assert.ok(markdown.endsWith(`… ${STOP_BUTTON}`));
  assert.doesNotMatch(markdown, /[\r\n]/u);
  const phrase = markdown.slice(LOADER.length + 1, -STOP_BUTTON.length - 1);
  const length = Array.from(phrase).length;
  assert.ok(length <= status.STATUS_PHRASE_MAX_CHARS, `${length}`);
  assert.ok(length > status.STATUS_PHRASE_MAX_CHARS - 10, `${length}`);
});

await test("разметка снята, теги не открываются: кнопка в статусе только своя", async () => {
  startTurn("105", "s-105", 504);
  const { calls, tg } = handle("105");

  await status.showTurnProgress(
    tg,
    "s-105",
    '## Шаг\n**Читаю** `notes/*.md` и [план](https://example.com/x) <tg-button type="callback_data" data="iva_cancel">Жми</tg-button> <b>жирно</b> ~~да~~ $x$ |a|',
  );

  const markdown = markdownOf(calls[0]);
  assert.equal((markdown.match(/<tg-button[\s>]/gu) ?? []).length, 1);
  assert.equal((markdown.match(/<tg-emoji[\s>]/gu) ?? []).length, 1);
  assert.ok(markdown.endsWith(STOP_BUTTON));
  const phrase = markdown.slice(LOADER.length + 1, -STOP_BUTTON.length - 1);
  assert.doesNotMatch(phrase, /[<>]/u);
  assert.doesNotMatch(phrase.replace(/\\./gu, ""), /[\\*_#|`[\]()~$]/u);
  assert.ok(visible(phrase).startsWith("Шаг Читаю notes/*.md и план "));
});

await test("пусто, пробелы и разметка без текста — правки нет", async () => {
  startTurn("106", "s-106", 505);
  const { calls, tg } = handle("106");

  for (const text of ["", " ", "\n\t \r\n", "```\n```", "\u00a0"])
    await status.showTurnProgress(tg, "s-106", text);

  assert.deepEqual(calls, []);
});

await test("нет статуса — нет правок: чат свободен, ход чужой, статус не отправлен", async () => {
  const { calls, tg } = handle("107");

  runStatus.setChatStatus(runStatus.chatKeyOf("107"), { status: "idle" });
  await status.showTurnProgress(tg, "s-107", "Ищу");
  startTurn("107", "s-other", 506);
  await status.showTurnProgress(tg, "s-107", "Ищу");
  startTurn("107", "s-107");
  await status.showTurnProgress(tg, "s-107", "Ищу");

  assert.deepEqual(calls, []);
});

await test("частые фразы: правка сразу, дальше не чаще интервала и с последней фразой", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const interval = status.STATUS_EDIT_INTERVAL_MS;
  startTurn("108", "s-108", 507);
  const { calls, tg } = handle("108");
  const phrases = () => calls.map((call) => visible(markdownOf(call)));

  await status.showTurnProgress(tg, "s-108", "Первая");
  for (const [at, text] of [
    [interval / 4, "Вторая"],
    [interval / 2, "Третья"],
    [interval - 1, "Четвёртая"],
  ] as const) {
    t.mock.timers.tick(at - (Date.now() - 1_000_000));
    await status.showTurnProgress(tg, "s-108", text);
  }
  await settle();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(phrases(), [
    `${LOADER} Первая ${STOP_BUTTON}`,
    `${LOADER} Четвёртая ${STOP_BUTTON}`,
  ]);

  // Тишина дольше интервала — следующая фраза уходит сразу.
  t.mock.timers.tick(interval * 5);
  await status.showTurnProgress(tg, "s-108", "Пятая");
  assert.equal(calls.length, 3);
  assert.ok(markdownOf(calls[2]).includes(" Пятая "));
});

await test("та же фраза второй раз статус не трогает: Telegram ответил бы «not modified»", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
  startTurn("109", "s-109", 508);
  const { calls, tg } = handle("109");

  await status.showTurnProgress(tg, "s-109", "Минуту.");
  t.mock.timers.tick(status.STATUS_EDIT_INTERVAL_MS * 2);
  await status.showTurnProgress(tg, "s-109", "Минуту.");
  await status.showTurnProgress(tg, "s-109", "  Минуту.\n");
  await settle();

  assert.equal(calls.length, 1);
});

await test("конец хода снимает отложенную фразу: уборка прежняя и последняя", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 3_000_000 });
  const chats = { completed: "111", cancelled: "112", failed: "113" };
  for (const mode of ["completed", "cancelled", "failed"] as const) {
    const chatId = chats[mode];
    startTurn(chatId, `s-${mode}`, 509);
    const { calls, tg } = handle(chatId);

    await status.showTurnProgress(tg, `s-${mode}`, "Первая");
    await status.showTurnProgress(tg, `s-${mode}`, "Отложенная");
    assert.equal(
      await status.finishTelegramStatus({ telegram: tg }, `s-${mode}`, mode),
      true,
    );
    t.mock.timers.tick(status.STATUS_EDIT_INTERVAL_MS * 3);
    await settle();
    await status.showTurnProgress(tg, `s-${mode}`, "После хода");

    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "editMessageText",
        mode === "cancelled" ? "editMessageText" : "deleteMessage",
      ],
      mode,
    );
    assert.ok(markdownOf(calls[0]).includes(" Первая "), mode);
    if (mode === "cancelled") assert.match(markdownOf(calls[1]), /^⏹ Stopped/u);
    assert.equal(
      runStatus.getChatStatus(runStatus.chatKeyOf(chatId))?.status,
      "idle",
    );
  }
});

await test("правка в полёте, когда ход кончился: «Остановлено» уходит после неё", async () => {
  startTurn("120", "s-120", 510);
  let release!: () => void;
  const held = new Promise<Reply>((resolve) => {
    release = () => resolve({ ok: true, body: { result: true } });
  });
  const { calls, tg } = handle("120", (call) =>
    markdownOf(call).includes(" Долгая ")
      ? held
      : { ok: true, body: { result: true } },
  );

  const progress = status.showTurnProgress(tg, "s-120", "Долгая");
  await settle();
  const finish = status.finishTelegramStatus(
    { telegram: tg },
    "s-120",
    "cancelled",
  );
  await settle();
  assert.equal(calls.length, 1, "уборка не ждала правку в полёте");

  release();
  await progress;
  assert.equal(await finish, true);
  assert.equal(calls.length, 2);
  assert.match(markdownOf(calls[1]), /^⏹ Stopped/u);
});

await test("сбой правки не роняет ход: отказ Telegram и исключение только в журнал", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 4_000_000 });
  startTurn("121", "s-121", 511);
  let attempt = 0;
  const { calls, tg } = handle("121", () => {
    attempt++;
    if (attempt === 1)
      return { ok: false, body: { description: "Bad Request: x" } };
    throw new Error("network down");
  });
  const logged: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args));

  await status.showTurnProgress(tg, "s-121", "Раз");
  t.mock.timers.tick(status.STATUS_EDIT_INTERVAL_MS);
  await status.showTurnProgress(tg, "s-121", "Два");
  await settle();

  assert.equal(calls.length, 2);
  assert.equal(logged.length, 2);
  // Терминал хода после сбоев идёт как обычно.
  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-121", "completed"),
    true,
  );
});

await test(`фраза статуса из любого текста — одна строка, без разметки, не длиннее STATUS_PHRASE_MAX_CHARS (seed ${SEED})`, () => {
  const markup = fc.constantFrom(
    "**",
    "__",
    "`",
    "```\n",
    "~~",
    "||",
    "<",
    ">",
    "</tg-button>",
    '<tg-button type="callback_data" data="x">',
    '<tg-emoji emoji-id="1">',
    "[",
    "](https://e.x)",
    "\\",
    "#",
    "|",
    "$",
    "&lt;",
    "&amp;",
    "\n",
    "\r\n",
    "\t",
    "<!-- iva:silent -->",
    "\uE000",
    "\uE001",
  );
  const text = fc.oneof(
    fc.string({ unit: "binary", maxLength: 400 }),
    fc
      .array(fc.oneof(markup, fc.string({ maxLength: 12 })), { maxLength: 80 })
      .map((parts) => parts.join("")),
  );
  fc.assert(
    fc.property(text, (input) => {
      const phrase = status.statusPhrase(input);
      assert.doesNotMatch(phrase, /[\r\n]/u);
      assert.doesNotMatch(phrase, /[<>]/u);
      assert.doesNotMatch(phrase.replace(/\\./gu, ""), /[\\*_#|`[\]()~$]/u);
      assert.ok(
        Array.from(visible(phrase)).length <= status.STATUS_PHRASE_MAX_CHARS,
      );
      assert.equal(phrase, phrase.trim());
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`ключ в любом месте текста до чата не доезжает и куском (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 300 }),
      fc.string({ maxLength: 300 }),
      (before, after) => {
        const phrase = status.statusPhrase(`${before} ${KEY} ${after}`);
        assert.equal(survivingChunk(phrase, KEY), null);
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});

await test("rich-статус не принят — фраза в статус не идёт", async () => {
  // Последним: отказ rich выключает rich-статус процесса навсегда.
  const rejected = handle("130", (call) =>
    call.method === "sendRichMessage"
      ? { ok: false, body: { description: "rich unsupported" } }
      : { ok: true, body: { result: { message_id: 512 } } },
  );
  assert.equal(await status.sendWorkingStatus(rejected.tg), 512);
  startTurn("130", "s-130", 512);
  const before = rejected.calls.length;

  await status.showTurnProgress(rejected.tg, "s-130", "Ищу");

  assert.equal(rejected.calls.length, before);
});
