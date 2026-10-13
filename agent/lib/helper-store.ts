import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dataDir } from "./data-dir.ts";
import { acquireLock, releaseLock, saveJsonAtomic } from "./json-store.ts";
import { traceHelper, type HelperTraceEvent } from "./trace.ts";

export const HELPER_MAX_OPEN = 3,
  HELPER_MAX_ROWS = 20;
export const HELPER_DEADLINE_MS = 2700000,
  HELPER_GRACE_MS = 120000;
export const HELPER_MAX_STEPS = 80,
  HELPER_CEILING_TOKENS = 1000000;
export const HELPER_MIN_FREE_MB = 600,
  HELPER_SECOND_FREE_MB = 3000;
export const HELPER_START_WAIT_MS = 600000,
  HELPER_CHECK_MS = 15000;
export const HELPER_SUMMARY_MAX = 1500,
  HELPER_KEEP_MS = 86400000;
export const HELPER_WAKE_PAUSE_MS = 180000,
  HELPER_WAKE_PAUSE_MAX_MS = 3600000;
export const HELPER_ESCALATE_WAKES = 6,
  HELPER_POLL_WAIT_S = 5;
export const HELPER_UPDATE_BASE = 2 ** 52;
const integer = z.number().int().nonnegative();
const text = z.string().min(1);
const chatSchema = z.strictObject({ id: text, threadId: text.nullable() });
const markSchema = z.strictObject({
  sessionId: text,
  turnId: text,
  at: integer,
});
const runSchema = z.strictObject({
  firedAt: integer,
  ownerPid: integer.positive(),
  ownerStartedAt: integer,
  childPid: integer.positive().nullable(),
  deadlineAtMs: integer,
  sessionId: text.nullable(),
});
const rowSchema = z
  .strictObject({
    id: z.string().regex(/^h-[0-9a-f]{6}$/),
    task: z.string().trim().min(1).max(2000),
    may: z.string().max(500),
    chat: chatSchema,
    createdAt: integer,
    status: z.enum(["pending", "finished", "closed"]),
    run: runSchema.nullable(),
    stop: z.enum(["deadline", "ceiling", "closed"]).nullable(),
    outcome: z
      .enum([
        "done",
        "empty",
        "failed",
        "deadline",
        "ceiling",
        "interrupted",
        "stopped",
      ])
      .nullable(),
    summary: z.string().max(HELPER_SUMMARY_MAX).nullable(),
    reason: z.string().nullable(),
    model: z.string().nullable(),
    steps: integer,
    tokens: integer,
    finishedAt: integer.nullable(),
    wake: z.strictObject({ updateId: integer, sent: z.boolean() }).nullable(),
    wakes: integer,
    lastWakeAt: integer.nullable(),
    shown: markSchema.nullable(),
    delivered: markSchema.nullable(),
    escalated: z.boolean(),
  })
  .refine(
    (r) =>
      (r.status === "pending"
        ? r.outcome === null && r.finishedAt === null
        : r.outcome !== null && r.finishedAt !== null && r.run === null) &&
      (r.stop === null || r.run !== null || r.outcome !== null) &&
      (!r.delivered ||
        (r.status === "finished" &&
          r.shown &&
          sameKey(r.shown, r.delivered))) &&
      (!r.wake ||
        (r.wake.updateId > HELPER_UPDATE_BASE && r.lastWakeAt !== null)),
    "inconsistent helper row",
  );
const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    wakeSeq: integer,
    rows: z.array(rowSchema).max(HELPER_MAX_ROWS),
  })
  .refine(
    (s) =>
      new Set(s.rows.map((r) => r.id)).size === s.rows.length &&
      s.rows.filter((r) => r.status === "pending").length <= HELPER_MAX_OPEN &&
      new Set(s.rows.flatMap((r) => (r.wake ? [r.wake.updateId] : []))).size ===
        s.rows.filter((r) => r.wake).length &&
      s.rows.every(
        (r) => !r.wake || r.wake.updateId <= HELPER_UPDATE_BASE + s.wakeSeq,
      ),
    "duplicate id or pending capacity",
  );
export type HelperRow = z.infer<typeof rowSchema>;
export type HelpersState = z.infer<typeof stateSchema>;
export type HelperChat = HelperRow["chat"];
export type HelperRun = z.infer<typeof runSchema>;
export type HelperTurnKey = Omit<z.infer<typeof markSchema>, "at">;
export type HelperTurnMark = z.infer<typeof markSchema>;
export type HelperStatus = HelperRow["status"];
export type HelperStop = NonNullable<HelperRow["stop"]>;
export type HelperOutcome = NonNullable<HelperRow["outcome"]>;
export type HelperInputSource = "owner" | "tap" | "wake";
export type HelperExpected =
  { kind: "pending"; createdAt: number } | { kind: "running"; firedAt: number };
export type HelperFinish = Pick<
  HelperRow,
  "summary" | "reason" | "model" | "steps" | "tokens"
> & { outcome: HelperOutcome };
export type HelperShow = { row: HelperRow; moreReady: number };
export type HelperClose = {
  row: HelperRow;
  branch: "pending" | "running" | "finished";
};
export type HelperRefusal =
  | "invalid-input"
  | "capacity"
  | "max-rows"
  | "not-found"
  | "foreign-chat"
  | "no-outcome"
  | "second-finished"
  | "already-delivered";
export type HelperResult<T extends object> =
  ({ ok: true } & T) | { ok: false; reason: HelperRefusal; text: string };
export type { HelperTraceEvent } from "./trace.ts";
export class HelperStoreError extends Error {}
const file = () => join(dataDir(), "helpers.json");
const root = () => join(dataDir(), "helpers");
const sameChat = (a: HelperChat, b: HelperChat) =>
  a.id === b.id && a.threadId === b.threadId;
const sameKey = (a: HelperTurnKey, b: HelperTurnKey) =>
  a.sessionId === b.sessionId && a.turnId === b.turnId;
const ready = (r: HelperRow) => r.status === "finished" && r.delivered === null;
const running = (r: HelperRow, firedAt: number) =>
  r.run?.firedAt === firedAt && r.outcome === null;
const refuse = (reason: HelperRefusal, text: string) => ({
  ok: false as const,
  reason,
  text,
});
export function helperResultPath(id: string): string {
  if (!/^h-[0-9a-f]{6}$/.test(id))
    throw new HelperStoreError("invalid helper id");
  return join(root(), id, "out", "result.md");
}
export async function readHelpers(): Promise<HelpersState> {
  let raw: string;
  try {
    raw = await readFile(file(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, wakeSeq: 0, rows: [] };
    throw new HelperStoreError(`${file()}: ${String(error)}`);
  }
  try {
    return stateSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new HelperStoreError(`${file()}: ${String(error)}`);
  }
}
async function locked<T>(fn: (s: HelpersState) => Promise<T>): Promise<T> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const path = `${file()}.lock`,
    token = await acquireLock(path);
  try {
    return await fn(await readHelpers());
  } finally {
    releaseLock(path, token);
  }
}
async function save(s: HelpersState) {
  await saveJsonAtomic(file(), stateSchema.parse(s), { mode: 0o600 });
}
export const getHelper = async (id: string) =>
  (await readHelpers()).rows.find((r) => r.id === id) ?? null;
export const listHelpers = async (chat: HelperChat) =>
  (await readHelpers()).rows.filter((r) => sameChat(r.chat, chat));
async function change(
  id: string,
  event: HelperTraceEvent,
  fn: (r: HelperRow, s: HelpersState) => boolean,
): Promise<HelperRow | null> {
  return locked(async (s) => {
    const r = s.rows.find((r) => r.id === id);
    if (!r || !fn(r, s)) {
      traceHelper("race_lost", id, {});
      return null;
    }
    await save(s);
    traceHelper(event, id, {
      data: { outcome: r.outcome, stop: r.stop, firedAt: r.run?.firedAt },
    });
    return r;
  });
}
export async function addHelper(
  input: { task: string; may: string; chat: HelperChat },
  now: number,
): Promise<HelperResult<{ row: HelperRow }>> {
  const parsed = z
    .strictObject({
      task: rowSchema.shape.task,
      may: rowSchema.shape.may,
      chat: chatSchema,
    })
    .safeParse(input);
  if (!parsed.success) return refuse("invalid-input", parsed.error.message);
  return locked(async (s) => {
    const pending = s.rows.filter((r) => r.status === "pending");
    if (s.rows.length >= HELPER_MAX_ROWS)
      return refuse(
        "max-rows",
        `20 helper rows: ${s.rows.map((r) => r.id).join(", ")}. Read or close outcomes.`,
      );
    if (pending.length >= HELPER_MAX_OPEN)
      return refuse(
        "capacity",
        `${pending.filter((r) => r.run).length} running, ${pending.filter((r) => !r.run).length} waiting, ${s.rows.filter(ready).length} outcomes; pending maximum 3. Wait, read or close.`,
      );
    await mkdir(root(), { recursive: true, mode: 0o700 });
    for (let i = 0; i < 32; i++) {
      const id = `h-${randomBytes(3).toString("hex")}`,
        dir = join(root(), id);
      if (s.rows.some((r) => r.id === id) || existsSync(dir)) continue;
      await mkdir(dir, { mode: 0o700 });
      try {
        await mkdir(dirname(helperResultPath(id)), { mode: 0o700 });
        const row: HelperRow = {
          ...parsed.data,
          id,
          createdAt: now,
          status: "pending",
          run: null,
          stop: null,
          outcome: null,
          summary: null,
          reason: null,
          model: null,
          steps: 0,
          tokens: 0,
          finishedAt: null,
          wake: null,
          wakes: 0,
          lastWakeAt: null,
          shown: null,
          delivered: null,
          escalated: false,
        };
        s.rows.push(row);
        await save(s);
        traceHelper("added", id, {});
        return { ok: true, row };
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    }
    return refuse("capacity", "Helper id collided 32 times; try again.");
  });
}
export const claimHelper = (
  id: string,
  owner: { ownerPid: number; ownerStartedAt: number; maxRunning: number },
  now: number,
) =>
  change(id, "claimed", (r, s) => {
    if (
      r.status !== "pending" ||
      r.run ||
      r.stop ||
      s.rows.filter((r) => r.run).length >= owner.maxRunning
    )
      return false;
    r.run = {
      firedAt: now,
      ownerPid: owner.ownerPid,
      ownerStartedAt: owner.ownerStartedAt,
      childPid: null,
      deadlineAtMs: now + HELPER_DEADLINE_MS,
      sessionId: null,
    };
    return true;
  });
export const recordHelperChild = (
  id: string,
  firedAt: number,
  childPid: number,
) =>
  change(id, "started", (r) => {
    if (!running(r, firedAt) || !r.run || r.run.childPid !== null) return false;
    r.run.childPid = childPid;
    return true;
  });
export async function recordHelperSession(
  id: string,
  firedAt: number,
  sessionId: string,
): Promise<boolean> {
  return (
    (await change(id, "started", (r) => {
      if (
        !running(r, firedAt) ||
        !r.run ||
        (r.run.sessionId !== null && r.run.sessionId !== sessionId)
      )
        return false;
      r.run.sessionId = sessionId;
      return true;
    })) !== null
  );
}
export const stopHelper = (id: string, firedAt: number, stop: HelperStop) =>
  change(id, "stopping", (r) => {
    if (!running(r, firedAt)) return false;
    r.stop ??= stop;
    return true;
  });
function finishRow(r: HelperRow, f: HelperFinish, now: number) {
  Object.assign(r, f, {
    outcome: r.stop === "closed" ? "stopped" : (r.stop ?? f.outcome),
    status: r.stop === "closed" ? "closed" : "finished",
    run: null,
    finishedAt: now,
  });
}
export const finalizeHelper = (
  id: string,
  expected: HelperExpected,
  finish: HelperFinish,
  now: number,
) =>
  change(id, "finished", (r) => {
    if (
      r.outcome !== null ||
      r.status !== "pending" ||
      (expected.kind === "running"
        ? !running(r, expected.firedAt)
        : r.run !== null || r.createdAt !== expected.createdAt)
    )
      return false;
    finishRow(r, finish, now);
    return true;
  });
export async function closeHelper(
  id: string,
  chat: HelperChat,
  now: number,
): Promise<HelperResult<HelperClose>> {
  return locked(async (s) => {
    const row = s.rows.find((r) => r.id === id);
    if (!row) return refuse("not-found", "Helper not found.");
    if (!sameChat(row.chat, chat))
      return refuse("foreign-chat", "Helper belongs to another chat.");
    if (row.delivered)
      return refuse("already-delivered", "Outcome already delivered.");
    const branch = row.run ? "running" : row.outcome ? "finished" : "pending";
    if (branch === "running") row.stop ??= "closed";
    else if (branch === "pending") {
      row.stop = "closed";
      finishRow(
        row,
        {
          outcome: "stopped",
          summary: null,
          reason: null,
          model: null,
          steps: 0,
          tokens: 0,
        },
        now,
      );
    } else row.status = "closed";
    await save(s);
    traceHelper("closed", id, {});
    return { ok: true, row, branch };
  });
}
export function helperNextWakeAt(row: HelperRow): number {
  return row.lastWakeAt === null
    ? (row.finishedAt ?? Infinity)
    : Math.max(
        row.finishedAt ?? Infinity,
        row.lastWakeAt +
          Math.min(
            HELPER_WAKE_PAUSE_MS * 2 ** row.wakes,
            HELPER_WAKE_PAUSE_MAX_MS,
          ),
      );
}
export const allocateHelperWake = (id: string, now: number) =>
  change(id, "wake", (r, s) => {
    if (!ready(r) || helperNextWakeAt(r) > now) return false;
    if (!r.wake || r.wake.sent) {
      const seq = s.wakeSeq + 1,
        updateId = HELPER_UPDATE_BASE + seq;
      if (!Number.isSafeInteger(updateId))
        throw new HelperStoreError("wake id overflow");
      s.wakeSeq = seq;
      r.wake = { updateId, sent: false };
    }
    r.lastWakeAt = now;
    return true;
  });
export async function showHelper(
  id: string,
  chat: HelperChat,
  key: HelperTurnKey,
  now: number,
): Promise<HelperResult<HelperShow>> {
  return locked(async (s) => {
    const row = s.rows.find((r) => r.id === id);
    if (!row) return refuse("not-found", "Helper not found.");
    if (!sameChat(row.chat, chat))
      return refuse("foreign-chat", "Helper belongs to another chat.");
    if (row.outcome === null && row.stop !== "closed")
      return refuse("no-outcome", "Helper has not finished.");
    if (ready(row)) {
      const first = s.rows.find(
        (r) =>
          ready(r) &&
          sameChat(r.chat, chat) &&
          r.shown &&
          sameKey(r.shown, key),
      );
      if (first && first.id !== id)
        return refuse(
          "second-finished",
          `Read ${first.id} in this turn; read the next outcome in another turn.`,
        );
      if (!row.shown || !sameKey(row.shown, key)) {
        row.shown = { ...key, at: now };
        await save(s);
        traceHelper("shown", id, { data: key });
      }
    }
    return {
      ok: true,
      row,
      moreReady: s.rows.filter(
        (r) => r.id !== id && sameChat(r.chat, chat) && ready(r),
      ).length,
    };
  });
}
export async function markHelperDelivered(
  chat: HelperChat,
  key: HelperTurnKey,
  now: number,
): Promise<HelperRow | null> {
  return locked(async (s) => {
    const row = s.rows.find(
      (r) =>
        ready(r) && sameChat(r.chat, chat) && r.shown && sameKey(r.shown, key),
    );
    if (!row) return null;
    row.delivered = { ...key, at: now };
    await save(s);
    traceHelper("delivered", row.id, { data: key });
    return row;
  });
}
export const stampHelperWake = (id: string, updateId: number, now: number) =>
  change(id, "wake", (r) => {
    integer.parse(now);
    if (!ready(r) || r.wake?.updateId !== updateId || r.wake.sent) return false;
    r.wake.sent = true;
    r.wakes++;
    return true;
  });
export const markHelperEscalated = (id: string, now: number) =>
  change(id, "escalated", (r) => {
    integer.parse(now);
    if (!ready(r) || r.escalated || r.wakes < HELPER_ESCALATE_WAKES)
      return false;
    r.escalated = true;
    return true;
  });
export async function sweepHelpers(now: number): Promise<string[]> {
  return locked(async (s) => {
    const removed = s.rows
      .filter(
        (r) =>
          !r.run &&
          ((r.status === "closed" &&
            r.finishedAt !== null &&
            r.finishedAt + HELPER_KEEP_MS <= now) ||
            (r.delivered && r.delivered.at + HELPER_KEEP_MS <= now)),
      )
      .map((r) => r.id);
    if (removed.length) {
      s.rows = s.rows.filter((r) => !removed.includes(r.id));
      await save(s);
    }
    for (const entry of await readdir(root()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    ))
      if (/^h-[0-9a-f]{6}$/.test(entry) && !s.rows.some((r) => r.id === entry))
        await rm(join(root(), entry), { recursive: true, force: true });
    return removed;
  });
}
