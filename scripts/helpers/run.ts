import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as s from "#lib/helper-store.ts";
import { traceHelper } from "#lib/trace.ts";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { ownerTimeZone } from "#lib/reminder-time.ts";
import { formatZoned } from "#lib/zoned-time.ts";
import {
  runReminderTurn,
  reminderClientOptions,
  isQuietReply,
  type HelperStepUsage,
  type ReminderTurn,
} from "../lib/reminder-turn.ts";
export function helperWork(previous: number, usage: HelperStepUsage): number {
  return (
    Math.max(0, (usage.inputTokens ?? 0) - previous) + (usage.outputTokens ?? 0)
  );
}
export function helperSummary(text: string): string | null {
  const bounded = text
    .trim()
    .slice(0, s.HELPER_SUMMARY_MAX)
    .replace(/[\uD800-\uDBFF]$/u, "");
  const paragraph = bounded.lastIndexOf("\n\n");
  if (text.length > s.HELPER_SUMMARY_MAX && paragraph > 0)
    return bounded.slice(0, paragraph);
  return bounded || null;
}
export async function runHelper(id: string): Promise<void> {
  const row = await s.getHelper(id),
    run = row?.run;
  if (!row || !run || !Number.isSafeInteger(run.firedAt))
    throw Error("helper claim is missing");
  const controller = new AbortController();
  let previous = 0,
    tokens = 0,
    steps = 0,
    session: string | null = run.sessionId,
    model: string | null = null;
  const check = async () => {
    try {
      const current = await s.getHelper(id);
      if (!current || current.run?.firedAt !== run.firedAt || current.stop)
        controller.abort();
      else if (Date.now() >= run.deadlineAtMs) {
        await s.stopHelper(id, run.firedAt, "deadline");
        controller.abort();
      }
    } catch (error) {
      console.error("helper check:", error);
      controller.abort();
    }
  };
  const timer = setInterval(() => {
    void check();
  }, s.HELPER_CHECK_MS);
  await check();
  const completed = async (turn: ReminderTurn) => {
    const stop = (await s.getHelper(id))?.stop;
    const text =
        turn.status === "failed" || stop
          ? (turn.partial ?? "")
          : (turn.message ?? ""),
      usable = text.trim() && !isQuietReply(text);
    let reason =
      turn.status === "failed"
        ? `${turn.message ?? "ход помощника упал"}; /menu`
        : turn.reason === "step-limit"
          ? "предел шагов"
          : null;
    if (stop)
      reason =
        stop === "deadline"
          ? "истёк срок помощника"
          : stop === "ceiling"
            ? "предел работы помощника"
            : "помощник закрыт";
    if (usable)
      try {
        await writeFileAtomic(s.helperResultPath(id), text, { mode: 0o600 });
      } catch (error) {
        console.error("helper result:", error);
        reason = `${reason ?? ""}; полный текст не записан`;
      }
    await s.finalizeHelper(
      id,
      { kind: "running", firedAt: run.firedAt },
      {
        outcome:
          turn.status === "failed"
            ? "failed"
            : turn.reason === "step-limit"
              ? "ceiling"
              : usable
                ? "done"
                : "empty",
        summary: usable ? helperSummary(text) : null,
        reason: reason ?? (usable ? null : "помощник вернул пустой итог"),
        model,
        steps,
        tokens,
      },
      Date.now(),
    );
  };
  let created = false;
  try {
    const base = reminderClientOptions(process.env, "helper");
    const options = {
      ...base,
      headers: {
        ...base.headers,
        "x-iva-helper": id,
        "x-iva-helper-fired": String(run.firedAt),
      },
    };
    created = true;
    const message = `Helper ${id}. Now: ${formatZoned(Date.now(), ownerTimeZone())}. Allowed: ${row.may || "nothing, look and draft only"}. Task: ${row.task}`;
    await runReminderTurn(message, options, {
      signal: controller.signal,
      helperCheckMs: s.HELPER_CHECK_MS,
      onCompleted: completed,
      onSession: async (sessionId) => {
        session = sessionId;
        try {
          const recorded = await s.recordHelperSession(
            id,
            run.firedAt,
            sessionId,
          );
          if (recorded) return true;
          const current = (await s.getHelper(id))?.run;
          return (
            current?.firedAt === run.firedAt && current.sessionId === sessionId
          );
        } catch (error) {
          traceHelper("session_unrecorded", id, {
            session: sessionId,
            data: { error: String(error) },
          });
          return false;
        }
      },
      onStepUsage: (usage) => {
        tokens += helperWork(previous, usage);
        previous = usage.inputTokens ?? 0;
        steps++;
        model = usage.model ?? model;
        if (steps === 1)
          traceHelper("started", id, {
            session: session ?? undefined,
            data: { model, firedAt: run.firedAt },
          });
        if (tokens > s.HELPER_CEILING_TOKENS)
          void s
            .stopHelper(id, run.firedAt, "ceiling")
            .then(() => controller.abort())
            .catch((error) => {
              console.error(error);
              controller.abort();
            });
      },
    });
  } catch (error) {
    if (created) throw error;
    console.error("helper options:", error);
    await completed({
      status: "failed",
      message: "Для помощника не задан ключ Ивы; выполни iva doctor.",
      feedback: () => Promise.resolve(),
    });
  } finally {
    clearInterval(timer);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runHelper(process.argv[2] ?? "").catch((error) => {
    console.error("helper:", error);
    process.exitCode = 1;
  });
