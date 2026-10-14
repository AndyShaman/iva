import { Worker } from "node:worker_threads";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { addAbortSignal } from "node:stream";
import { relative, sep } from "node:path";
import {
  globToRegExp,
  eachFile,
  resolveVaultToolRoot,
  WALK_HINT,
  walkBound,
  type WalkBound,
} from "../lib/vault-file-search.ts";

// Host-native grep. Переопределяет встроенный grep eve: regex-поиск по содержимому
// реальных файлов на ФС VPS (node:fs + RegExp в отдельном потоке). Обход и резолв корня общие с glob.

interface Match {
  file: string;
  line: number;
  text: string;
}

const MAX_MATCHES = 1000;

async function* filesAt(
  root: string,
  bound: WalkBound,
): AsyncGenerator<string> {
  if ((await stat(root)).isFile()) yield root;
  else yield* eachFile(root, bound);
}

async function* lineBatches(
  file: string,
  signal?: AbortSignal,
): AsyncGenerator<string[]> {
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  if (signal) addAbortSignal(signal, stream);
  let pending: string[] = [];
  try {
    for await (const chunk of stream) {
      const parts = String(chunk).split("\n");
      if (parts.length === 1) {
        pending.push(parts[0]);
        continue;
      }
      parts[0] = pending.join("") + parts[0];
      pending = [parts.pop()!];
      yield parts;
    }
    // split("\\n") includes an empty final line after a trailing newline, including an empty file.
    yield [pending.join("")];
  } catch {
    if (signal?.aborted) throw new Error("поиск отменён");
    return;
  } finally {
    stream.destroy();
  }
}

// One worker per search, reused across files; model regex never runs on the event loop.
const MATCH_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", ({lines, offset, limit}) => {
  parentPort.postMessage({kind: "started"});
  const matches = [];
  const started = performance.now();
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0;
    if (expression.test(lines[index])) matches.push({
      line: offset + index + 1,
      text: lines[index].length > 300 ? lines[index].slice(0, 300) + "…" : lines[index]
    });
    if (performance.now() - started > workerData.matchTimeMs) {
      parentPort.postMessage({kind: "error", error: "выражение слишком тяжёлое, упрости"});
      return;
    }
    if (matches.length >= limit) break;
  }
  parentPort.postMessage({kind: "matched"});
  parentPort.postMessage({kind: "result", matches});
});
`;
const MATCH_TIME_MS = 1000;
type LineMatch = Omit<Match, "file">;

function matchLines(
  worker: Worker,
  lines: string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<LineMatch[]> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error: Error | null, matches: LineMatch[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.off("message", receive);
      worker.off("error", failed);
      worker.off("exit", exited);
      if (error) reject(error);
      else resolve(matches);
    };
    const abort = () => finish(new Error("поиск отменён"));
    const receive = (message: {
      kind: string;
      matches?: LineMatch[];
      error?: string;
    }) => {
      if (message.kind === "started")
        timer = setTimeout(
          () => finish(new Error("выражение слишком тяжёлое, упрости")),
          MATCH_TIME_MS,
        );
      else if (message.kind === "matched") clearTimeout(timer);
      else if (message.kind === "error") finish(new Error(message.error));
      else if (message.kind === "result") finish(null, message.matches);
    };
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error("поток поиска завершился"));
    worker.on("message", receive);
    worker.once("error", failed);
    worker.once("exit", exited);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else if (worker.threadId === -1) exited();
    else worker.postMessage({ lines, offset, limit });
  });
}

async function matchesInFile(
  file: string,
  worker: Worker,
  limit: number,
  signal?: AbortSignal,
): Promise<Match[]> {
  const matches: Match[] = [];
  let offset = 0;
  for await (const lines of lineBatches(file, signal)) {
    const found = await matchLines(
      worker,
      lines,
      offset,
      limit - matches.length,
      signal,
    );
    matches.push(...found.map((match) => ({ file, ...match })));
    offset += lines.length;
    if (matches.length >= limit) break;
  }
  return matches;
}

function result(matches: Match[], full: boolean, bound: WalkBound) {
  const truncated = full || bound.truncated;
  const hint = bound.truncated ? { hint: WALK_HINT } : {};
  return { count: matches.length, truncated, ...hint, matches };
}

async function findMatches(
  root: string,
  worker: Worker,
  globExpression: RegExp | null,
  bound: WalkBound,
): Promise<ReturnType<typeof result>> {
  const matches: Match[] = [];
  for await (const file of filesAt(root, bound)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (globExpression !== null && !globExpression.test(relativePath)) continue;
    const remaining = MAX_MATCHES - matches.length;
    const additions = await matchesInFile(
      file,
      worker,
      remaining,
      bound.signal,
    );
    matches.push(...additions.slice(0, remaining));
    if (additions.length >= remaining) return result(matches, true, bound);
  }
  return result(matches, false, bound);
}

export default defineTool({
  description:
    "Regex-поиск по файлам хоста. path — абсолютный или от корня vault файл либо " +
    "директория (по умолчанию корень vault, рекурсивно); glob фильтрует по пути; " +
    "flags — RegExp-флаги ('i', 'm'). " +
    "Возвращает { file, line, text }, до 1000; бинарные пропускаются.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Регулярное выражение"),
    path: z.string().optional().describe("Абсолютный или от корня vault путь"),
    glob: z.string().optional().describe("Glob-фильтр, напр. **/*.ts"),
    flags: z.string().optional().describe("Напр. 'i' или 'm'"),
  }),
  async execute({ pattern, path, glob, flags }, { abortSignal }) {
    const root = resolveVaultToolRoot(path);
    const bound = walkBound(abortSignal);
    let worker: Worker | undefined;
    try {
      // Validation only: malformed model input returns text in this turn.
      new RegExp(pattern, flags ?? "");
      if (abortSignal?.aborted) {
        bound.truncated = true;
        return result([], false, bound);
      }
      worker = new Worker(MATCH_SOURCE, {
        eval: true,
        workerData: { pattern, flags: flags ?? "", matchTimeMs: MATCH_TIME_MS },
      });
      worker.on("error", () => {});
      return await findMatches(
        root,
        worker,
        glob ? globToRegExp(glob) : null,
        bound,
      );
    } catch (error) {
      return {
        ...result([], false, bound),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await worker?.terminate();
    }
  },
});
