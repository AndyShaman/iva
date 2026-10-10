// Статус-сообщение хода: «Работаю…» с кнопкой [⏹ Стоп] и его уборка в терминале.
// Это UI самого канала, поэтому мимо Outbox.
//
// Статус — rich message (sendRichMessage): лоадер и кнопка <tg-button>
// стоят в одной строке текста. Стиль меню на статус не влияет.
//
// Что модель говорит по ходу работы (текст шага перед вызовом инструментов), встаёт в
// статус между лоадером и кнопкой: статус правится на месте, отдельного сообщения нет
// (решение владельца 10.10.2026). Это уже текст модели, поэтому он проходит outbound-Gate.
// Гейт грузится при первой фразе, а не вместе с модулем: мост (scripts/poller/control.ts)
// берёт отсюда stoppedText и TELEGRAM_STOP_CALLBACK, и сломанный модуль гейта не должен
// мешать ему стартовать — как в scripts/lib/notice.ts.
//
// turn.started шлёт статус и пишет running+sessionId+turnId в run-status.
// Нажатие кнопки (и /stop) ловит Bridge: он берёт sessionId и зовёт cancel-роут
// канала, а terminal-событие приводит статус в порядок: обычный финал удаляет
// сообщение, отмена переписывает его на «Остановлено».
//
// Про eve модуль не знает: канал передаёт хендл Bot API структурно.
import { tr } from "./i18n.ts";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import {
  htmlToPlain,
  mdToTelegramHtml,
  richQuoteLine,
} from "./telegram-format.ts";
import { isPrivateTelegramChatHandle } from "./telegram-private-chat.ts";

// В callback_data кладём только константу: лимит 64 байта не вмещает sessionId,
// он и так лежит в run-status.
export const TELEGRAM_STOP_CALLBACK = "iva_cancel";

export type TelegramStatusHandle = {
  readonly chatId: string;
  readonly chatType?: string;
  readonly messageThreadId?: number;
  request(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }>;
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо — module-level
// const не должна захватывать tr(), иначе язык замерзает до рестарта).
// Экспорт нужен мосту: сообщение «ход не остановился» переписывается тем же текстом, когда
// подтверждение всё-таки приходит.
export function stoppedText(): string {
  return tr(
    "⏹ Stopped. I'll hold new messages and handle them together with the next one.",
    "⏹ Остановлено. Новые сообщения накоплю и обработаю вместе со следующим.",
  );
}

// Анимированный лоадер статуса — тот же набор, что у /update
// (t.me/addemoji/iconemoji1), печатающие точки, чтобы «Работаю…» визуально
// отличался от обновления. Без Premium у владельца бота Telegram вернёт 400 на
// custom_emoji — тогда анимация выключается навсегда, а текст падает на обычные ⏳.
const WORK_LOADER = {
  alt: "💬",
  customEmojiId: "5818797194127346654",
  fallback: "⏳",
};
const FALLBACK_STATUS_SUFFIX = " …";
let workLoaderSupported = true;
// Рич-путь целиком: старый Bot API не знает sendRichMessage. Один отказ — и статус
// уходит обычным текстом, как до rich; повторять отказ на каждом ходу незачем.
let richStatusSupported = true;

// Строка статуса. Лоадер падает на ⏳, когда Telegram отверг custom emoji. Фраза модели,
// если есть, стоит между лоадером и кнопкой; она уже прошла statusPhrase.
function workingMarkdown({
  withStop = true,
  phrase = "",
}: { withStop?: boolean; phrase?: string } = {}): string {
  const loader = workLoaderSupported
    ? `<tg-emoji emoji-id="${WORK_LOADER.customEmojiId}">${WORK_LOADER.alt}</tg-emoji>`
    : WORK_LOADER.fallback;
  const line = phrase === "" ? loader : `${loader} ${phrase}`;
  return withStop
    ? `${line} <tg-button type="callback_data" style="danger" data="${TELEGRAM_STOP_CALLBACK}">⏹</tg-button>`
    : line;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageIdFromResponse(response: { body: unknown }): number | null {
  const body = asRecord(response.body);
  const result = asRecord(body?.result);
  return typeof result?.message_id === "number" ? result.message_id : null;
}

/** Builds the shared Telegram request body for a quiet temporary status message. */
function statusBody(tg: TelegramStatusHandle): Record<string, unknown> {
  return {
    chat_id: tg.chatId,
    disable_notification: true,
    ...(tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
  };
}

export async function sendWorkingStatus(
  tg: TelegramStatusHandle,
  { canStop = true } = {},
): Promise<number | null> {
  // Кнопку показываем только в личке, где Bridge примет её callback.
  const withStop = canStop && isPrivateTelegramChatHandle(tg);
  const base = statusBody(tg);
  if (richStatusSupported) {
    const res = await tg.request("sendRichMessage", {
      ...base,
      rich_message: { markdown: workingMarkdown({ withStop }) },
    });
    if (res.ok) return messageIdFromResponse(res);
    // 400 на custom_emoji: кнопка остаётся (она в тексте), а анимация — нет.
    if (workLoaderSupported) {
      workLoaderSupported = false;
      const withoutEmoji = await tg.request("sendRichMessage", {
        ...base,
        rich_message: { markdown: workingMarkdown({ withStop }) },
      });
      if (withoutEmoji.ok) return messageIdFromResponse(withoutEmoji);
    }
    richStatusSupported = false;
    console.error(
      "[telegram] sendRichMessage для статуса отвергнут, шлю обычный текст:",
      JSON.stringify(res.body).slice(0, 300),
    );
  }
  // Статус обязан быть виден даже там, где rich не приняли: без кнопки и анимации,
  // но «Работаю…» в чате есть.
  const fallback = await tg.request("sendMessage", {
    ...base,
    text: WORK_LOADER.fallback + FALLBACK_STATUS_SUFFIX,
  });
  return fallback.ok ? messageIdFromResponse(fallback) : null;
}

// Ранний статус уходит без кнопки: ход ещё не начался, отменять нечего. Начался — кнопку
// дорисовываем в то же сообщение и по тому же правилу личного чата.
export async function enableWorkingStatusStop(
  tg: TelegramStatusHandle,
  messageId: number,
): Promise<void> {
  if (!isPrivateTelegramChatHandle(tg)) return;
  if (!richStatusSupported) return;
  await tg.request("editMessageText", {
    chat_id: tg.chatId,
    message_id: messageId,
    rich_message: { markdown: workingMarkdown({ withStop: true }) },
  });
}

// Терминал хода: state → idle (+wasCancelled), статус-сообщение удалить (обычный финал)
// или переписать на «Остановлено» (отмена). Сбои уборки не критичны — глотаем.
// Знак очереди (сообщение за этим ходом) любой финал оставляет следующему ходу: буфер
// входа eve переживает и отмену (steer отменяет ход ради нового сообщения), и сбой хода.
export async function finishTelegramStatus(
  channel: {
    telegram: TelegramStatusHandle;
  },
  sessionId: string,
  mode: "completed" | "cancelled" | "failed",
): Promise<boolean> {
  const tg = channel.telegram;
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  const st = getChatStatus(key);
  // Compare and update happen under one per-chat lock. A reset can remove
  // sessionId after this read; a late terminal event then becomes a no-op.
  const casOk = setChatStatusIf(
    key,
    { sessionId },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      compacting: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      ...(mode === "cancelled" ? { wasCancelled: true } : {}),
    },
  );
  // Only touch Telegram when the pre-CAS snapshot was OUR session. A late
  // terminal event from an old finished session must not delete another
  // live session's Working… message in the same chat.
  if (st?.sessionId === sessionId) {
    const msgId = st.statusMessageId;
    if (typeof msgId === "number") {
      try {
        // Правка фразы не должна лечь поверх уборки: отложенная снимается, начатая
        // дожидается (не дольше срока), и удаление или «Остановлено» идут последними.
        const { late } = await stopTurnProgress(key, msgId);
        if (mode === "cancelled") {
          const stopped = () =>
            tg.request("editMessageText", {
              chat_id: tg.chatId,
              message_id: msgId,
              rich_message: { markdown: stoppedText() },
            });
          await stopped();
          // Правка, не ответившая в срок, могла лечь после «Остановлено» — ставим его снова.
          // Удалённое сообщение поздняя правка не вернёт: там повторять нечего.
          void late
            ?.then((landed) => (landed ? stopped() : undefined))
            .catch(() => {
              /* не критично, как и вся уборка */
            });
        } else {
          await tg.request("deleteMessage", {
            chat_id: tg.chatId,
            message_id: msgId,
          });
        }
      } catch {
        /* статус-сообщение не убралось — не критично */
      }
    }
  }
  return Boolean(casOk);
}

// Фраза модели в статусе — одна строка не длиннее стольких знаков (с «…» на обрезе).
export const STATUS_PHRASE_MAX_CHARS = 120;
// Статус правится не чаще раза в столько миллисекунд: Telegram ограничивает частоту правок
// (в группе — 20 сообщений в минуту), а шаги модели бывают чаще. Фразы между правками не
// копятся: через интервал в статус встаёт последняя.
export const STATUS_EDIT_INTERVAL_MS = 3_000;
// Столько ждём ответа Telegram на правку статуса. Не ответил — уборка хода идёт дальше, а
// статус до конца хода больше не правится. Срок короче интервала: правки не встают в очередь.
export const STATUS_EDIT_TIMEOUT_MS = 5_000;

/**
 * Текст шага модели как фраза статуса: сначала outbound-Gate по всему тексту (обрезанный
 * ключ гейт уже не узнаёт), потом разметка снимается тем же конвертером, что у Outbox, и
 * остаётся одна экранированная строка не длиннее STATUS_PHRASE_MAX_CHARS. Пусто — "".
 * Гейт не загрузился — исключение, и фразы нет: текст модели мимо гейта в чат не идёт.
 */
export async function statusPhrase(text: string): Promise<string> {
  const { redactNotice } = await import("./outbox.ts");
  return richQuoteLine(
    htmlToPlain(mdToTelegramHtml(redactNotice(text))),
    STATUS_PHRASE_MAX_CHARS,
  );
}

// Фраза статуса одного хода: какое сообщение правим, что в нём уже стоит, когда правили,
// что ждёт интервала. Правки одного статуса идут цепочкой: поздняя не обгонит раннюю.
type TurnProgress = {
  readonly sessionId: string;
  readonly messageId: number;
  shown: string;
  editedAt: number;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  // Звено цепочки кончается не позже STATUS_EDIT_TIMEOUT_MS и не отклоняется никогда.
  editing: Promise<void>;
  // Правка, не ответившая в срок: true, если Telegram её всё же принял. Она может лечь
  // после уборки статуса.
  late: Promise<boolean> | undefined;
  // Статус второстепенен: раз Telegram не ответил в срок, до конца хода его не правим.
  quiet: boolean;
};

const turnProgress = new Map<string, TurnProgress>();

// Статус-сообщение живого хода этой сессии; нет такого — null, и правок нет.
function turnStatusMessageId(key: string, sessionId: string): number | null {
  const st = getChatStatus(key);
  return st?.status === "running" &&
    st.sessionId === sessionId &&
    typeof st.statusMessageId === "number"
    ? st.statusMessageId
    : null;
}

function progressOf(
  key: string,
  sessionId: string,
  messageId: number,
): TurnProgress {
  const known = turnProgress.get(key);
  if (known?.sessionId === sessionId && known.messageId === messageId)
    return known;
  clearTimeout(known?.timer);
  const fresh: TurnProgress = {
    sessionId,
    messageId,
    shown: "",
    editedAt: -Infinity,
    pending: null,
    timer: undefined,
    editing: Promise.resolve(),
    late: undefined,
    quiet: false,
  };
  turnProgress.set(key, fresh);
  return fresh;
}

const logProgressError = (error: unknown) =>
  console.error("[telegram] статус хода не обновился:", error);

// Ход мог кончиться, пока фраза ждала интервала: тогда статус уже не наш.
function stillShowing(key: string, progress: TurnProgress): boolean {
  if (turnProgress.get(key) !== progress) return false;
  let messageId: number | null = null;
  try {
    messageId = turnStatusMessageId(key, progress.sessionId);
  } catch (error) {
    logProgressError(error);
  }
  if (messageId === progress.messageId) return true;
  turnProgress.delete(key);
  return false;
}

// Одна правка статуса со сроком: Bot API своего срока не знает, и повисший запрос держал бы
// уборку хода. Не ответил за STATUS_EDIT_TIMEOUT_MS — звено кончается, статус замолкает до
// конца хода, а сам запрос остаётся в progress.late.
async function sendEdit(
  tg: TelegramStatusHandle,
  body: Record<string, unknown>,
  progress: TurnProgress,
): Promise<void> {
  const sent = (async () => {
    try {
      const res = await tg.request("editMessageText", body);
      if (!res.ok) logProgressError(JSON.stringify(res.body).slice(0, 300));
      return res.ok;
    } catch (error) {
      logProgressError(error);
      return false;
    }
  })();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadline = setTimeout(
      () => resolve("expired"),
      STATUS_EDIT_TIMEOUT_MS,
    ).unref();
  });
  const outcome = await Promise.race([sent, expired]);
  clearTimeout(deadline);
  if (outcome !== "expired") return;
  progress.quiet = true;
  progress.late = sent;
  logProgressError(
    `Telegram не ответил на правку за ${STATUS_EDIT_TIMEOUT_MS} мс`,
  );
}

function editTurnStatus(
  tg: TelegramStatusHandle,
  key: string,
  progress: TurnProgress,
): void {
  clearTimeout(progress.timer);
  progress.timer = undefined;
  const phrase = progress.pending;
  progress.pending = null;
  if (
    phrase === null ||
    phrase === progress.shown ||
    progress.quiet ||
    !stillShowing(key, progress)
  )
    return;
  progress.shown = phrase;
  progress.editedAt = Date.now();
  const body = {
    chat_id: tg.chatId,
    message_id: progress.messageId,
    rich_message: {
      markdown: workingMarkdown({
        withStop: isPrivateTelegramChatHandle(tg),
        phrase,
      }),
    },
  };
  // Цепочку ждёт уборка статуса в конце хода, а шаг модели — нет.
  progress.editing = progress.editing.then(() => sendEdit(tg, body, progress));
}

/**
 * Текст шага модели встаёт в статус хода: лоадер, фраза, ⏹. Первая фраза хода — сразу,
 * следующие — не чаще STATUS_EDIT_INTERVAL_MS, и из накопившихся за интервал берётся
 * последняя. Нет статус-сообщения у живого хода этой сессии или rich-статус не принят —
 * правок нет. Ответа Telegram на правку шаг не ждёт; сбой правки остаётся в журнале и ход
 * не трогает.
 */
export async function showTurnProgress(
  tg: TelegramStatusHandle,
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    if (!richStatusSupported) return;
    const phrase = await statusPhrase(text);
    if (phrase === "") return;
    const key = chatKeyOf(tg.chatId, tg.messageThreadId);
    const messageId = turnStatusMessageId(key, sessionId);
    if (messageId === null) return;
    const progress = progressOf(key, sessionId, messageId);
    progress.pending = phrase;
    const wait = progress.editedAt + STATUS_EDIT_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      editTurnStatus(tg, key, progress);
      return;
    }
    progress.timer ??= setTimeout(
      () => editTurnStatus(tg, key, progress),
      wait,
    ).unref();
  } catch (error) {
    logProgressError(error);
  }
}

// Конец хода: отложенная фраза снимается, начатая правка дожидается, но не дольше
// STATUS_EDIT_TIMEOUT_MS. В ответе — правка, не ответившая в срок: она может лечь после
// уборки. Обёрнута в объект: обещание, отданное из async-функции, ждали бы целиком.
async function stopTurnProgress(
  key: string,
  messageId: number,
): Promise<{ late?: Promise<boolean> }> {
  const progress = turnProgress.get(key);
  if (progress?.messageId !== messageId) return {};
  clearTimeout(progress.timer);
  turnProgress.delete(key);
  await progress.editing;
  return { late: progress.late };
}
