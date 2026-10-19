import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  commandFile,
  commandLog,
  list,
  recordDelivery,
} from "#lib/reminder-store.ts";
import { dataDir } from "#lib/data-dir.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";
import { ownerChat } from "../lib/notification-chat.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { isEntrypoint } from "../lib/version-layout.ts";

const MAX_LOG = 32_000;
export async function runCommand(
  command: string,
  root: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; error: string | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(command, {
      cwd: root,
      shell:
        ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path)) ?? true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          output = `${output}\nprocess group: ${String(error)}`.slice(-MAX_LOG);
        }
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-MAX_LOG);
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, output });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const error = timedOut
        ? `timeout after ${timeoutMs} ms`
        : code === 0
          ? null
          : `exit ${code ?? signal}`;
      resolve({ ok: error === null, error, output });
    });
  });
}

export async function runCommandFire(
  id: string,
  options: {
    root?: string;
    timeoutMs?: number;
    firedAt?: number;
    send?: typeof sendTelegramHtml;
  } = {},
): Promise<number> {
  const file = commandFile();
  const row = (await list(file)).find((candidate) => candidate.id === id);
  if (
    !row ||
    row.firedAt === null ||
    (options.firedAt !== undefined && row.firedAt !== options.firedAt)
  )
    return 2;
  const result = await runCommand(
    row.text,
    options.root ?? process.cwd(),
    options.timeoutMs,
  );
  const log = commandLog(id);
  let previous = "";
  try {
    previous = readFileSync(log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(
    log,
    (
      previous +
      `\n${new Date().toISOString()} ${id} ${result.error ?? "ok"}\n${result.output}`
    ).slice(-MAX_LOG),
    { mode: 0o600 },
  );
  await recordDelivery(
    id,
    { firedAt: row.firedAt, delivered: result.ok, error: result.error },
    { file },
  );
  const key = `schedule-${id}`;
  if (result.ok) alertResolved(dataDir(), key);
  else
    await alertOnce(dataDir(), key, result.error ?? "error", async () => {
      const chat = ownerChat(process.env);
      if (!chat) return false;
      return (
        await (options.send ?? sendTelegramHtml)(
          process.env.TELEGRAM_BOT_TOKEN ?? "",
          chat,
          `задача ${id} не выполнилась: ${result.error}`,
        )
      ).ok;
    });
  return 0;
}
if (isEntrypoint(import.meta.url))
  process.exit(
    await runCommandFire(process.argv[2] ?? "", {
      firedAt: Number(process.argv[3]),
    }),
  );
