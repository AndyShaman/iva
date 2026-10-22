// Вход /compact из моста. Захват чата и POST eve остаются общими с автосвёрткой.
import type { RouteHandlerArgs } from "eve/channels";
import { verifyTelegramRequest } from "eve/channels/telegram";
import {
  parseTelegramResetTarget,
  type ResetTarget,
} from "./telegram-reset-route.ts";
import { getChatStatus, isRunning } from "./run-status.ts";
import { manualCompactionInput } from "./idle-compaction.ts";
import { tr } from "./i18n.ts";

export const TELEGRAM_COMPACT_ROUTE = "/eve/v1/telegram/compact";
export const compactThousands = (tokens: number) => Math.round(tokens / 1000);

async function readCompactRequest(req: Request, secretToken?: string) {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  let body: { chatKey?: unknown; target?: unknown } | null;
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const key = body?.chatKey;
  const target = parseTelegramResetTarget(body?.target);
  if (typeof key !== "string" || !/^-?\d+:\d*$/u.test(key) || !target)
    return new Response("chatKey and target are required", { status: 400 });
  return { key, target };
}

type CompactOperations = Pick<
  RouteHandlerArgs,
  "attachSession" | "resolveSession"
>;
function resolveCompactSession(
  target: ResetTarget,
  operations: CompactOperations,
) {
  if (target.sessionId !== undefined)
    return operations.attachSession(target.sessionId);
  const address = target.address;
  return operations.resolveSession(
    `${address.chatId}:${address.messageThreadId ?? ""}:${address.conversationId ?? ""}`,
  );
}

export async function handleTelegramCompactRequest(
  req: Request,
  operations: CompactOperations,
  start: (chatKey: string, sessionId: string) => Promise<boolean>,
  secretToken?: string,
): Promise<Response> {
  const parsed = await readCompactRequest(req, secretToken);
  if (parsed instanceof Response) return parsed;
  const { key, target } = parsed;
  if (isRunning(key))
    return Response.json({
      text: tr(
        "I'm answering now. Try /compact after I finish.",
        "Сейчас идёт ответ. Повтори /compact, когда закончу.",
      ),
    });
  const session = await resolveCompactSession(target, operations);
  if (
    !session ||
    getChatStatus(key)?.resetAt !== undefined ||
    manualCompactionInput(session.id) === null
  )
    return Response.json({
      text: tr(
        "There's nothing to compress yet: the conversation is small or has already been compressed.",
        "Пока сжимать нечего: разговор небольшой или уже сжат.",
      ),
    });
  const accepted = await start(key, session.id);
  return Response.json({
    text: accepted
      ? tr(
          "Compressing the conversation. I'll show its new size with the next answer.",
          "Сжимаю разговор. Новый размер покажу со следующим ответом.",
        )
      : tr(
          "Compression couldn't be confirmed. Try /compact after the chat is free.",
          "Подтверждение сжатия пока отсутствует. Повтори /compact, когда чат освободится.",
        ),
  });
}
