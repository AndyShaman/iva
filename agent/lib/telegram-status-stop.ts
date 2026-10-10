// Кнопка ⏹ статуса хода и текст «Остановлено» — то, что из статуса нужно мосту
// (scripts/poller/control.ts). Отдельный модуль без Outbox и outbound-Gate: сломанный модуль
// гейта (половина обновления) не мешает мосту стартовать. Статус хода
// (telegram-status-message.ts) берёт оба отсюда, а кнопку отдаёт каналу тем же именем.
import { tr } from "./i18n.ts";

// В callback_data кладём только константу: лимит 64 байта не вмещает sessionId,
// он и так лежит в run-status.
export const TELEGRAM_STOP_CALLBACK = "iva_cancel";

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
