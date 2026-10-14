import { type HelperOutcome, HELPER_SUMMARY_MAX } from "./helper-store.ts";
export function isQuietReply(text: string): boolean {
  return /^[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*quiet[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*$/iu.test(
    text,
  );
}
export function helperSummary(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length <= HELPER_SUMMARY_MAX
    ? trimmed || null
    : trimmed
        .slice(0, HELPER_SUMMARY_MAX - 1)
        .replace(/[\uD800-\uDBFF]$/u, "") + "…";
}
type Usage = { inputTokens?: number; outputTokens?: number };
export function helperWork(previous: number, usage: Usage): number {
  return (
    Math.max(0, (usage.inputTokens ?? 0) - previous) + (usage.outputTokens ?? 0)
  );
}
const ends: Record<string, HelperOutcome> = {
  "turn.completed": "done",
  "session.completed": "done",
  "turn.failed": "failed",
  "session.failed": "failed",
  "input.requested": "failed",
  "authorization.required": "failed",
  "turn.cancelled": "interrupted",
};
export function foldHelperSnapshot(
  events: readonly { type: string; data?: unknown }[],
) {
  let text: string | null = null,
    model: string | null = null,
    started: string | null = null,
    steps = 0,
    tokens = 0,
    previous = 0,
    ended = false,
    outcome: HelperOutcome = "empty",
    reason: string | null = null;
  for (const event of events) {
    if (!event || typeof event.type !== "string")
      throw Error("invalid helper snapshot");
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "message.completed" && typeof d.message === "string")
      text = d.message;
    if (event.type === "step.started" && typeof d.modelId === "string")
      started = d.modelId;
    if (event.type === "step.completed") {
      const usage = (d.usage ?? {}) as Usage;
      steps++;
      tokens += helperWork(previous, usage);
      previous = usage.inputTokens ?? 0;
      model = typeof d.providerModelId === "string" ? d.providerModelId : null;
    }
    if (!ended && Object.hasOwn(ends, event.type)) {
      ended = true;
      outcome = ends[event.type];
      if (outcome === "failed")
        reason =
          typeof d.message === "string" ? d.message : "ход помощника упал";
      if (event.type === "input.requested") reason = "помощник ждал ответа";
      if (event.type === "authorization.required")
        reason = "помощник ждал авторизации";
      if (outcome === "done" && d.reason === "step-limit") {
        outcome = "ceiling";
        reason = "предел шагов";
      }
    }
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw Error("invalid helper usage");
  if (outcome === "done" && (!text?.trim() || isQuietReply(text)))
    outcome = "empty";
  return {
    text,
    ended,
    outcome,
    reason,
    model: model ?? started,
    steps,
    tokens,
  };
}
