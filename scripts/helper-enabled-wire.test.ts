/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
process.env.AGENT_LANGUAGE = "en";
process.env.ASSISTANT_TIMEZONE = "UTC";
type Wire = {
  tools: { name: string; [key: string]: unknown }[];
  prefix: unknown[];
};
const base = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-w3-base.json", import.meta.url),
    "utf8",
  ),
) as { wires: Record<string, Wire> };
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-enabled-wire.json", import.meta.url),
    "utf8",
  ),
) as Wire;
const enabled = { tools: fixture.tools, prefix: fixture.prefix };
test("real installed framework registry removes only the three automatic task tools", async () => {
  const { frameworkAgentSourceRegistry } =
    await import("../node_modules/eve/dist/src/framework/sources/registry.js");
  const paths = frameworkAgentSourceRegistry.registrations.flatMap((r) =>
    r.source.modules.map((m) => m.logicalPath),
  );
  for (const removed of ["agent", "task_cancel", "task_update"])
    assert.ok(!paths.includes(`tools/${removed}.ts`));
  for (const kept of [
    "bash",
    "read_file",
    "write_file",
    "todo",
    "web_fetch",
    "load_skill",
    "connection_search",
    "ask_question",
    "web_search",
  ])
    assert.ok(paths.includes(`tools/${kept}.ts`));
  assert.ok(paths.includes("agent.ts"));
});
test("enabled tools on the provider wire equal the base minus removed tools plus helper, keeping every retained schema and description", async () => {
  const previous = Object.values(base.wires)[0];
  const removed = new Set(["agent", "task_cancel", "task_update", "planner"]);
  assert.deepEqual(
    enabled.tools.filter((t) => t.name !== "helper"),
    previous.tools.filter((t) => !removed.has(t.name)),
  );
  assert.ok(enabled.tools.find((t) => t.name === "helper"));
  for (const kind of "chat reminder signal watch brief insight alert helper".split(
    " ",
  )) {
    const actual = await wireTurn({ kind });
    assert.deepEqual(actual.wire.tools, enabled.tools, kind);
  }
});
test("helper start/finish/read leave the static prefix and full set unchanged", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "iva-enabled-prefix-"));
  const before = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const s = await import("../agent/lib/helper-store.ts");
    const r = await s.addHelper(
      { task: "Find it", may: "", chat: { id: "41", threadId: null } },
      1000,
    );
    assert.ok(r.ok);
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
    await s.finalizeHelper(
      r.row.id,
      { kind: "pending", createdAt: 1000 },
      {
        outcome: "done",
        summary: "found",
        reason: null,
        model: "fixture",
        steps: 1,
        tokens: 10,
      },
      2000,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
    await s.showHelper(r.row.id, { id: "41", threadId: null });
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});
