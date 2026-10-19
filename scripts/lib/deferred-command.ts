import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
const requestSchema = z.object({
  id: z.string().uuid(),
  argv: z.array(z.string()).min(1),
  createdAt: z.string().datetime(),
  pid: z.number().int().positive().optional(),
  result: z.boolean().optional(),
});
const resultText = (ok: boolean) => (ok ? "выполнено" : "ошибка выполнения");
const pendingPath = (dir: string) => join(dir, "deferred-command.json");
const activePath = (dir: string) => join(dir, "deferred-command.active.json");
const read = (file: string) =>
  existsSync(file)
    ? requestSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : null;
export function deferrable(argv: readonly string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) return false;
  return (
    "restart stop update rollback reset full-reset doctor"
      .split(" ")
      .includes(argv[0]) ||
    (argv[0] === "plugin" &&
      "trust enable update sync install-proposal".split(" ").includes(argv[1]))
  );
}
export async function deferCommand(dir: string, argv: readonly string[]) {
  const { acquireLock, releaseLock, saveJsonAtomic } =
    await import("#lib/json-store.ts");
  const file = pendingPath(dir);
  const token = await acquireLock(`${file}.lock`);
  try {
    await saveJsonAtomic(
      file,
      { id: randomUUID(), argv, createdAt: new Date().toISOString() },
      { mode: 0o600 },
    );
  } finally {
    releaseLock(`${file}.lock`, token);
  }
  console.log(`${argv.join(" ")} выполнится сразу после конца этого хода`);
}
export async function executeDeferred(dir: string, root: string, id: string) {
  const { acquireLock, releaseLock, saveJsonAtomic } =
    await import("#lib/json-store.ts");
  const file = pendingPath(dir);
  const token = await acquireLock(`${file}.lock`);
  let request;
  try {
    request = read(file);
    if (!request || request.id !== id || existsSync(activePath(dir))) return;
    request = { ...request, pid: process.pid };
    await saveJsonAtomic(file, request, { mode: 0o600 });
    renameSync(file, activePath(dir));
  } finally {
    releaseLock(`${file}.lock`, token);
  }
  const env = { ...process.env, ASSISTANT_DATA_DIR: dir, IVA_AGENT_TURN: "" };
  const cli = (argv: readonly string[]) =>
    promisify(execFile)(
      process.execPath,
      [join(root, "bin/iva.mjs"), ...argv],
      { cwd: root, env, maxBuffer: 1024 * 1024 },
    );
  const result = await cli(request.argv)
    .then(() => true)
    .catch(() => false);
  await saveJsonAtomic(
    activePath(dir),
    { ...request, result },
    { mode: 0o600 },
  );
  await cli(["notify", `${request.argv[0]}: ${resultText(result)}.`]).then(
    () => rmSync(activePath(dir)),
    () => {},
  );
}
export async function reconcileDeferred(
  dir: string,
  io: {
    busy: () => boolean;
    launch: (argv: readonly string[]) => Promise<{ ok: boolean; msg: string }>;
    report: (text: string) => Promise<unknown>;
  },
): Promise<boolean> {
  const active = read(activePath(dir));
  if (active) {
    try {
      if (active.pid && process.kill(active.pid, 0)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const outcome =
      active.result === undefined
        ? "исполнение прервано; проверь iva status"
        : resultText(active.result);
    await io.report(`${active.argv.join(" ")}: ${outcome}.`);
    rmSync(activePath(dir));
  }
  const request = read(pendingPath(dir));
  if (!request) return false;
  if (!io.busy()) {
    const result = await io.launch(["_deferred", request.id]);
    if (!result.ok) throw new Error(`Deferred command: ${result.msg}`);
  }
  return true;
}
