import { Client, type CancelSessionResult } from "eve/client";
import { uptime } from "node:os";
import {
  OWNER_STARTED_AT,
  reservationOwnerIsDead,
  startScheduledJob,
} from "./schedule-runner.ts";
import * as s from "./helper-store.ts";
import { traceHelper } from "./trace.ts";
type TickOptions = {
  nowMs?: number;
  bootAt?: number;
  start?: typeof startScheduledJob;
  ownerDead?: typeof reservationOwnerIsDead;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  cancel?: (id: string) => Promise<CancelSessionResult>;
  completed?: { id: string; firedAt: number };
  log?: (...args: unknown[]) => void;
};
export async function runHelperTick(options: TickOptions = {}): Promise<void> {
  const now = options.nowMs ?? Date.now(),
    log = options.log ?? console.error;
  const alive =
    options.alive ??
    ((pid: number) => !reservationOwnerIsDead({ownerPid:pid,ownerStartedAt:0}));
  const cancel =
    options.cancel ??
    ((id: string) =>
      new Client({
        host:
          process.env.ASSISTANT_HOST ??
          `http://127.0.0.1:${process.env.IVA_PORT ?? "8723"}`,
        auth: { bearer: process.env.ASSISTANT_BEARER ?? "" },
      }).sessions
        .attach(id)
        .cancel({
          tasks: true,
          signal: AbortSignal.timeout(s.HELPER_CHECK_MS),
        }));
  try {
    const rows = (await s.readHelpers()).rows.sort(
      (a, b) => Number(!a.run) - Number(!b.run) || a.createdAt - b.createdAt,
    );
    for (const row of rows)
      try {
        const run = row.run;
        if (run) {
          const current =
            run.ownerPid === process.pid &&
            run.ownerStartedAt === OWNER_STARTED_AT &&
            !(options.ownerDead ?? reservationOwnerIsDead)(run) &&
            run.ownerStartedAt >= (options.bootAt ?? now - uptime() * 1000);
          const completed =
            options.completed?.id === row.id &&
            options.completed.firedAt === run.firedAt;
          const exited =
            completed || (run.childPid !== null && !alive(run.childPid));
          if (
            row.stop ||
            !current ||
            exited ||
            now >= run.deadlineAtMs + s.HELPER_GRACE_MS
          ) {
            if (current && run.childPid !== null && !exited)
              (options.kill ?? process.kill)(-run.childPid, "SIGKILL");
            if (run.sessionId) {
              if ((await cancel(run.sessionId)).status !== "no_active_turn")
                continue;
            } else if (!exited && current) continue;
            await s.finalizeHelper(
              row.id,
              { kind: "running", firedAt: run.firedAt },
              {
                outcome: now >= run.deadlineAtMs ? "deadline" : "interrupted",
                summary: row.summary,
                reason: "помощник остановлен после прерывания",
                model: row.model,
                steps: row.steps,
                tokens: row.tokens,
              },
              now,
            );
          }
        } else if (row.status === "pending") {
          const claimed = await s.claimHelper(
            row.id,
            {
              ownerPid: process.pid,
              ownerStartedAt: OWNER_STARTED_AT,
            },
            now,
          );
          if (!claimed?.run) continue;
          const child = await (options.start ?? startScheduledJob)({
            name: `helper-${row.id}`,
            argv: ["scripts/helpers/run.ts", row.id],
            root: process.cwd(),
            nodeBin: process.execPath,
          });
          if (child.startFailed)
            await s.finalizeHelper(
              row.id,
              { kind: "running", firedAt: now },
              {
                outcome: "failed",
                summary: null,
                reason: "помощник не смог начать",
                model: null,
                steps: 0,
                tokens: 0,
              },
              now,
            );
          else {
            void child.completion
              .then(() =>
                runHelperTick({ completed: { id: row.id, firedAt: now } }),
              )
              .catch(log);
            await s.recordHelperChild(row.id, now, child.pid);
          }
        }
      } catch (error) {
        if (error instanceof s.HelperStoreError) throw error;
        log("helper tick:", row.id, error);
      }
    await s.sweepHelpers(now);
  } catch (error) {
    log("helper tick:", error);
    if (error instanceof s.HelperStoreError)
      traceHelper("store_broken", null, { data: { error: String(error) } });
  }
}
