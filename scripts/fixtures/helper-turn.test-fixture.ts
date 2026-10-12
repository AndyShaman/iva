/* eslint-disable @typescript-eslint/require-await -- Async SDK boundary doubles. */
import "../lib/ts-esm-hooks.ts";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jsonSchema, APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { SessionContext } from "eve/tools";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../../node_modules/eve/dist/src/harness/types.js";
import type { AlsContext } from "../../node_modules/eve/dist/src/context/container.js";
const load = async <T>(root: string, path: string): Promise<T> =>
  (await import(pathToFileURL(join(root, path)).href)) as T;
import * as harness from "../../node_modules/eve/dist/src/harness/tool-loop.js";
import * as container from "../../node_modules/eve/dist/src/context/container.js";
import * as keys from "../../node_modules/eve/dist/src/context/keys.js";
import * as resolver from "../../node_modules/eve/dist/src/context/dynamic-resolve-context.js";
export const eveInternals = async () => ({
  ...harness,
  ...container,
  ...keys,
  ...resolver,
});
type Tool = HarnessToolMap extends ReadonlyMap<string, infer T> ? T : never;
type Instruction = { role?: string; content?: string; markdown?: string };
type Definition = {
  description: string;
  inputSchema: Parameters<
    typeof import("../../node_modules/eve/dist/src/tools/schema.js").serializeInputSchema
  >[0];
};
async function authoredTurn(root: string, kind: string) {
  const eve = await eveInternals();
  const { assistantBearerAuth } = await load<
    typeof import("../../agent/lib/eve-auth.ts")
  >(root, "agent/lib/eve-auth.ts");
  const auth = await assistantBearerAuth("fixture")(
    new Request("http://fixture.invalid", {
      headers: {
        authorization: "Bearer fixture",
        ...(kind === "chat" ? {} : { "x-iva-turn": kind }),
        ...(kind === "helper" ? { "x-iva-helper": "h-abc123" } : {}),
      },
    }),
  );
  const context = {
    session: {
      id: "fixture",
      auth: { initiator: auth, current: auth },
      turn: { id: "turn_0", sequence: 0 },
    },
  } as SessionContext;
  const instructions: Record<string, { role: "system"; content: string }[]> =
      {},
    userInstructions: { role: "user"; content: string }[] = [];
  for (const name of (await readdir(join(root, "agent/instructions")))
    .filter((n) => n.endsWith(".ts"))
    .sort()) {
    const mod = await load<{
      default: {
        events: Record<
          string,
          (
            e: unknown,
            c: SessionContext,
          ) => Promise<Instruction | null> | Instruction | null
        >;
      };
    }>(root, "agent/instructions/" + name);
    const value = await mod.default.events["turn.started"]({}, context);
    if (value?.role === "user")
      userInstructions.push({
        role: "user",
        content: value.content ?? value.markdown ?? "",
      });
    else if (value)
      instructions[name] = [
        { role: "system", content: value.content ?? value.markdown ?? "" },
      ];
  }
  const { composeRuntimeBasePrompt } = await load<
    typeof import("../../node_modules/eve/dist/src/runtime/prompt/compose.js")
  >(root, "node_modules/eve/dist/src/runtime/prompt/compose.js");
  const paths = [
    "agent/instructions.md",
    ...["10-map", "15-skills"].map((name) => `agent/instructions/${name}.md`),
  ];
  const staticInstructions = await Promise.all(
    paths.map(async (path) => ({
      role: "system" as const,
      sourceId: path,
      logicalPath: path,
      sourceKind: "markdown" as const,
      content: await readFile(join(root, path), "utf8"),
      name: path,
      owner: { kind: "application" as const },
    })),
  );
  const { default: matter } = await load<{
    default: (s: string) => { data: { description?: string } };
  }>(root, "node_modules/eve/dist/src/compiled/gray-matter/index.js");
  const skills = [];
  for (const entry of await readdir(join(root, "agent/skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() && !entry.name.endsWith(".md")) continue;
    const path = join(
      "agent/skills",
      entry.name,
      entry.isDirectory() ? "SKILL.md" : "",
    );
    skills.push({
      name: entry.name.replace(/\.md$/, ""),
      description:
        matter(await readFile(join(root, path), "utf8")).data.description ?? "",
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const connection = await load<{ default: { description: string } }>(
    root,
    "agent/connections/telegram-userbot.ts",
  );
  const system = composeRuntimeBasePrompt({
    instructions: staticInstructions,
    skills: skills as never,
    connections: [
      {
        connectionName: "telegram-userbot",
        description: connection.default.description,
      },
    ] as never,
    toolsAvailable: true,
    subagentsAvailable: true,
  }).join("\n\n");
  const tools = new Map<string, Tool>();
  const { serializeInputSchema } = await load<
    typeof import("../../node_modules/eve/dist/src/tools/schema.js")
  >(root, "node_modules/eve/dist/src/tools/schema.js");
  const add = (name: string, d: Definition) =>
    tools.set(name, {
      name,
      description: d.description,
      inputSchema: jsonSchema(serializeInputSchema(d.inputSchema)! as never),
      execute: async () => "ok",
    });
  for (const [name, path] of [
    ["todo", "provided/todo"],
    ["load_skill", "provided/load-skill"],
    ["ask_question", "framework/ask-question"],
    ["task_update", "framework/task-update"],
    ["task_cancel", "framework/task-cancel"],
    ["agent", "framework/agent"],
  ])
    add(
      name,
      (
        await load<{ default: Definition }>(
          root,
          "node_modules/eve/dist/src/tools/" + path + ".js",
        )
      ).default,
    );
  for (const name of await readdir(join(root, "agent/tools")))
    if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
      add(
        name.slice(0, -3),
        (await load<{ default: Definition }>(root, "agent/tools/" + name))
          .default,
      );
  const { createPreparedRuntimeSubagentTool } = await load<
    typeof import("../../node_modules/eve/dist/src/runtime/subagents/registry.js")
  >(root, "node_modules/eve/dist/src/runtime/subagents/registry.js");
  for (const name of await readdir(join(root, "agent/subagents"))) {
    const mod = await load<{ default: { description: string } }>(
      root,
      "agent/subagents/" + name + "/agent.ts",
    );
    const d = createPreparedRuntimeSubagentTool({
      kind: "subagent",
      name,
      description: mod.default.description,
      nodeId: name,
    } as never);
    tools.set(name, {
      name,
      description: d.description,
      inputSchema: jsonSchema(d.inputSchema! as never),
      execute: async () => "ok",
    });
  }
  const { ConnectionRegistryKey } = await load<
    typeof import("../../node_modules/eve/dist/src/context/providers/connection-key.js")
  >(root, "node_modules/eve/dist/src/context/providers/connection-key.js");
  const { resolveConnectionSearchDynamicTools } = await load<
    typeof import("../../node_modules/eve/dist/src/execution/tools/connection-search.js")
  >(root, "node_modules/eve/dist/src/execution/tools/connection-search.js");
  const discovery = new eve.ContextContainer();
  discovery.set(ConnectionRegistryKey, {
    getConnections: () => [{ connectionName: "telegram-userbot" }],
  } as never);
  const dynamic = await eve.contextStorage.run(discovery, () =>
    resolveConnectionSearchDynamicTools(),
  );
  add("connection_search", dynamic!.connection_search as Definition);
  const fixture = JSON.parse(
    await readFile(new URL("./helper-turn-base.json", import.meta.url), "utf8"),
  ) as { proxyMetadata: string };
  for (const d of JSON.parse(fixture.proxyMetadata) as (Definition & {
    name: string;
    inputSchema: Record<string, unknown>;
  })[])
    tools.set("connection__telegram-userbot__" + d.name, {
      name: "connection__telegram-userbot__" + d.name,
      description: d.description,
      inputSchema: jsonSchema(d.inputSchema as never),
      execute: async () => "ok",
    });
  return { eve, auth, context, instructions, userInstructions, system, tools };
}
export async function wireTurn(
  options: {
    root?: string;
    kind?: string;
    attributes?: Record<string, unknown>;
    currentAttributes?: Record<string, unknown>;
    calls?: number;
    noEvents?: boolean;
    retry?: boolean;
    compact?: boolean;
    onStep?: (ctx: AlsContext) => Promise<void>;
  } = {},
) {
  const authored = await authoredTurn(
    options.root ?? process.cwd(),
    options.kind ?? "chat",
  );
  const { eve } = authored,
    ctx = new eve.ContextContainer();
  const auth = {
    ...authored.auth!,
    attributes: (options.attributes ??
      authored.auth!.attributes) as NonNullable<
      typeof authored.auth
    >["attributes"],
  };
  ctx.set(eve.InitiatorAuthKey, auth);
  ctx.set(
    eve.AuthKey,
    options.currentAttributes
      ? {
          ...auth,
          attributes: options.currentAttributes as typeof auth.attributes,
        }
      : auth,
  );
  ctx.set(eve.SessionIdKey, "fixture");
  ctx.set(eve.TurnDynamicInstructionsKey, authored.instructions);
  let count = 0,
    executions = 0;
  const events: {
    type: string;
    data?: { reason?: string; [key: string]: unknown };
  }[] = [];
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  };
  const resultContent = () => {
    const call = ++count <= (options.calls ?? 0);
    return {
      call,
      content: call
        ? [
            {
              type: "tool-call" as const,
              toolCallId: "t" + count,
              toolName: "read_file",
              input: '{"path":"CORE.md"}',
            },
          ]
        : [{ type: "text" as const, text: "done" }],
    };
  };
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      const compact = params.prompt.some(
        (m) =>
          m.role === "system" &&
          m.content.includes("CONTEXT CHECKPOINT COMPACTION"),
      );
      const value = compact
        ? { call: false, content: [{ type: "text" as const, text: "summary" }] }
        : resultContent();
      return {
        content: value.content,
        usage,
        finishReason: {
          unified: value.call ? "tool-calls" : "stop",
          raw: "stop",
        },
        warnings: [],
      };
    },
    doStream: async () => {
      if (options.retry && model.doStreamCalls.length === 1)
        throw new APICallError({
          message: "retry",
          url: "http://fixture.invalid",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      const value = resultContent();
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            if (value.call) c.enqueue(value.content[0] as never);
            else {
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: "done" });
              c.enqueue({ type: "text-end", id: "t" });
            }
            c.enqueue({
              type: "finish",
              finishReason: {
                unified: value.call ? "tool-calls" : "stop",
                raw: "stop",
              },
              usage,
            });
            c.close();
          },
        }),
      };
    },
  });
  for (const [name, tool] of authored.tools)
    authored.tools.set(name, {
      ...tool,
      execute: async () => {
        executions++;
        return "ok";
      },
    });
  const run = eve.createToolLoopHarness({
    mode: "conversation",
    tools: authored.tools,
    resolveModel: async () => model,
    ...(options.noEvents
      ? {}
      : {
          handleEvent: async (event) => {
            events.push(event);
          },
        }),
    ...(options.onStep
      ? { dispatchDynamicModelEvent: async ({ ctx }) => options.onStep!(ctx) }
      : {}),
  });
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "fixture" },
      system: authored.system,
      tools: [],
    },
    compaction: {
      threshold: options.compact ? 1 : 100000,
      recentWindowSize: 1,
    },
    continuationToken: "fixture",
    sessionId: "fixture",
    history: options.compact
      ? Array.from({ length: 12 }, (_, i) => ({
          role: i % 2 ? ("assistant" as const) : ("user" as const),
          content: "history ".repeat(100),
        }))
      : authored.userInstructions,
  };
  let result = await eve.contextStorage.run(ctx, () =>
    run(session, { message: "hello" }),
  );
  for (let i = 0; typeof result.next === "function" && i < 8; i++) {
    const next = result.next;
    result = await eve.contextStorage.run(ctx, () => next(result.session));
  }
  if (
    typeof result.next === "function" ||
    events.some((e) => e.type === "turn.failed")
  )
    throw new Error("turn failed or did not settle");
  const call = model.doStreamCalls[0] ?? model.doGenerateCalls[0];
  const wire = {
    tools: call?.tools ?? [],
    prefix: (call?.prompt ?? []).filter((m) => m.role === "system"),
  };
  return { authored, ctx, result, wire, model, events, executions };
}
