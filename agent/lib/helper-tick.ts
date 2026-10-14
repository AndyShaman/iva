import { Client, type CancelSessionResult, type ResetResult } from "eve/client";
import { OWNER_STARTED_AT, runScheduledJob } from "./schedule-runner.ts";
import * as s from "./helper-store.ts";
import { traceHelper } from "./trace.ts";
const exitedClients = new Map<string, number>();
type TickOptions = {
  nowMs?: number;
  start?: typeof runScheduledJob;
  cancel?: (id: string) => Promise<CancelSessionResult>;
  reset?: (id: string) => Promise<ResetResult>;
  completed?: { id: string; firedAt: number };
  log?: (...args: unknown[]) => void;
};
export async function runHelperTick(options: TickOptions = {}): Promise<void> {
  const now = options.nowMs ?? Date.now(),
    log = options.log ?? console.error;
  const session = (id: string) =>
    new Client({
      host:
        process.env.ASSISTANT_HOST ??
        `http://127.0.0.1:${process.env.IVA_PORT ?? "8723"}`,
      auth: { bearer: process.env.ASSISTANT_BEARER ?? "" },
    }).sessions.attach(id);
  const cancel =
    options.cancel ??
    ((id: string) =>
      session(id).cancel({
        tasks: true,
        signal: AbortSignal.timeout(s.HELPER_CHECK_MS),
      }));
  const reset =
    options.reset ??
    ((id: string) =>
      session(id).reset({ signal: AbortSignal.timeout(s.HELPER_CHECK_MS) }));
  try {
    const rows = (await s.readHelpers()).rows.sort(
      (a, b) => Number(!a.run) - Number(!b.run) || a.createdAt - b.createdAt,
    );
    for (const row of rows)
      try {
        const run = row.run;
        if (!run) exitedClients.delete(row.id);
        if (run) {
          const current = run.ownerStartedAt === OWNER_STARTED_AT;
          const exited =
            (options.completed?.id === row.id &&
              options.completed.firedAt === run.firedAt) ||
            exitedClients.get(row.id) === run.firedAt;
          if (exited) exitedClients.set(row.id, run.firedAt);
          if (
            !current ||
            exited ||
            now >= run.deadlineAtMs + s.HELPER_GRACE_MS
          ) {
            if (run.sessionId) {
              await cancel(run.sessionId);
              await reset(run.sessionId);
            } else if (!exited && current) continue;
            const finished = await s.finalizeHelper(
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
            if (finished) {
              exitedClients.delete(row.id);
              traceHelper("finished", row.id, {
                session: run.sessionId ?? undefined,
                data: {
                  outcome: finished.outcome,
                  reason: finished.reason,
                  steps: finished.steps,
                  tokens: finished.tokens,
                },
              });
            }
          }
        } else if (row.status === "pending") {
          const claimed = await s.claimHelper(
            row.id,
            { ownerStartedAt: OWNER_STARTED_AT },
            now,
          );
          if (!claimed?.run) continue;
          void (options.start ?? runScheduledJob)({
            name: `helper-${row.id}`,
            argv: ["scripts/helpers/run.ts", row.id],
            root: process.cwd(),
            nodeBin: process.execPath,
            timeoutMs: s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
            log,
          })
            .then(async (result) => {
              if (result.error) {
                const finished = await s.finalizeHelper(
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
                  Date.now(),
                );
                if (finished)
                  traceHelper("finished", row.id, {
                    data: {
                      outcome: finished.outcome,
                      reason: finished.reason,
                    },
                  });
              } else
                await runHelperTick({
                  ...options,
                  nowMs: undefined,
                  completed: { id: row.id, firedAt: now },
                });
            })
            .catch(log);
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
