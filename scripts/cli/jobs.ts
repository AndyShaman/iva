// `iva jobs ack <name>` — закрыть незакрытый провал расписания (T20 п.3). Команда нужна
// ровно одна: без неё провал закрывался бы только успешным перезапуском, а «я посмотрела,
// чинить нечего» сказать нечем. Ставит acked=true на последней строке-провале имени.
import { readEnvFresh } from "../lib/env-file.ts";

type AckFacts = typeof import("#lib/job-facts.ts").ackFacts;
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type ReadEnv = typeof readEnvFresh;

export type JobsDependencies = {
  readonly ack?: AckFacts;
  readonly readEnv?: ReadEnv;
};

export function createJobsCommand(
  runtime: CliRuntime,
  dependencies: JobsDependencies = {},
) {
  const { ENV_PATH, bad, dataDirAbs, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  return async function cmdJobs(args: readonly string[]): Promise<void> {
    const [subcommand, name] = args;
    if (subcommand !== "ack" || !name)
      throw new Error("usage: iva jobs ack <name>");
    // Ремонт/доктор работают на установке без agent/ (authored-tree-guard): таблица
    // фактов живёт в authored tree, поэтому грузится внутри вызова, а не при импорте.
    const facts = await import("#lib/job-facts.ts");
    const env = await readEnv(ENV_PATH);
    const closed = await (dependencies.ack ?? facts.ackFacts)(
      facts.jobFactsFile(dataDirAbs(env)),
      name,
    );
    if (closed === 0) {
      bad(`no open failure for ${name}`);
      return;
    }
    ok(`closed ${closed} open failure(s) for ${name}`);
  };
}
