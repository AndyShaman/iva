/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import helperRole from "../agent/instructions/00-helper.ts";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
const home = await mkdtemp(join(tmpdir(), "iva-helper-wire-"));
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
process.env.ASSISTANT_DATA_DIR = join(home, "data");
process.env.MODEL_PROVIDER = "ollama";
process.env.AGENT_LANGUAGE = "en";
process.env.ASSISTANT_TIMEZONE = "UTC";
for (const dir of [
  "vault",
  "data/custom/agent/instructions",
  "data/custom/agent/skills/owner-fixture",
])
  await mkdir(join(home, dir), { recursive: true });
for (const [file, text] of [
  ["vault/CORE.md", "CORE_FIXTURE owner project"],
  ["vault/PERSONA.md", "PERSONA_FIXTURE concise"],
  ["data/custom/agent/instructions/rule.md", "OWNER_FIXTURE use dated sources"],
  [
    "data/custom/agent/skills/owner-fixture/SKILL.md",
    "---\nname: owner-fixture\ndescription: OWNER_SKILL_FIXTURE\n---\nOwner skill instructions.",
  ],
])
  await writeFile(join(home, file), text);
after(() => rm(home, { recursive: true, force: true }));
test("helper uses chat definitions and static block, retaining owner instructions and skills", async () => {
  const chat = await wireTurn(),
    helper = await wireTurn({ kind: "helper" });
  const current = {
    session: {
      ...helper.authored.context.session,
      auth: { current: helper.authored.auth, initiator: null },
    },
  };
  assert.ok(helperRole.events["turn.started"]!({}, current as never));
  assert.deepEqual(helper.wire.tools, chat.wire.tools);
  assert.ok(helper.wire.tools.some((t) => t.name.endsWith("__send_message")));
  assert.equal(helper.authored.system, chat.authored.system);
  assert.ok(helper.wire.prefix[0].content.startsWith(chat.authored.system));
  const prefix = JSON.stringify(helper.wire.prefix);
  assert.match(prefix, /background helper of Iva/);
  assert.match(prefix, /CORE_FIXTURE/);
  assert.match(prefix, /OWNER_FIXTURE/);
  assert.doesNotMatch(prefix, /PERSONA_FIXTURE/);
  assert.ok(!("40-open-failures.ts" in helper.authored.instructions));
  assert.equal(helper.authored.userInstructions.length, 0);
  assert.ok(chat.authored.userInstructions.length > 0);
  const custom = (await import("../agent/skills/custom.ts")).default;
  assert.match(
    JSON.stringify(
      await custom.events["turn.started"]!(
        {},
        helper.authored.eve.buildResolveContext(helper.ctx, []),
      ),
    ),
    /owner-fixture/,
  );
});
test("enabled turn wire stays identical across all existing turn kinds", async () => {
  const expected = (await wireTurn({ kind: "chat" })).wire;
  for (const kind of "chat reminder signal watch brief insight alert".split(
    " ",
  )) {
    const { wire } = await wireTurn({ kind });
    assert.equal(JSON.stringify(wire), JSON.stringify(expected), kind);
    assert.notEqual(
      JSON.stringify({ ...wire, tools: [...wire.tools].reverse() }),
      JSON.stringify(expected),
    );
  }
});
for (const noEvents of [false, true])
  for (const max of [1, 3])
    for (const calls of [0, max - 1, max, max + 1])
      test(`ceiling ${max}, calls ${calls}, observer ${!noEvents}`, async () => {
        const turn = await wireTurn({
          attributes: { iva_max_steps: String(max) },
          calls,
          noEvents,
        });
        const requests = noEvents
          ? turn.model.doGenerateCalls
          : turn.model.doStreamCalls;
        assert.equal(requests.length, Math.min(calls + 1, max));
        assert.equal(turn.executions, Math.min(calls, max - 1));
        assert.equal(turn.result.next, null);
        if (requests.length === max) {
          assert.deepEqual(requests.at(-1)!.tools ?? [], []);
          if (!noEvents)
            assert.equal(
              turn.events.find((e) => e.type === "turn.completed")?.data
                ?.reason,
              "step-limit",
            );
        }
      });
for (const value of [
  0,
  -1,
  1.5,
  "03",
  "0",
  "-1",
  "1.5",
  "1000000000",
  "80\n",
  " 80",
  "80 ",
  NaN,
  Infinity,
  [],
  1e20,
])
  test(`specified garbage ${String(value)} closes at one`, async () => {
    const turn = await wireTurn({
      attributes: { iva_max_steps: value },
      calls: 4,
      noEvents: true,
    });
    assert.equal(turn.model.doGenerateCalls.length, 1);
    assert.equal(turn.executions, 0);
  });
test("minimum is symmetric and retry/compaction are outside the step count", async () => {
  for (const [first, current] of [
    [1, 3],
    [3, 1],
  ]) {
    const turn = await wireTurn({
      attributes: { iva_max_steps: String(first) },
      currentAttributes: { iva_max_steps: String(current) },
      calls: 3,
    });
    assert.equal(turn.model.doStreamCalls.length, 1);
  }
  const retry = await wireTurn({
    attributes: { iva_max_steps: "2" },
    calls: 4,
    retry: true,
  });
  assert.equal(retry.model.doStreamCalls.length, 3);
  assert.equal(retry.executions, 1);
  const compact = await wireTurn({
    attributes: { iva_max_steps: "2" },
    calls: 4,
    compact: true,
  });
  assert.ok(compact.model.doGenerateCalls.length > 0);
  assert.equal(compact.model.doStreamCalls.length, 2);
  assert.equal(compact.executions, 1);
});

test("live helper observations compare ordered hashes and fail closed", async () => {
  const { helperWireResult, liveTurnHeaders } = await import("./live-turn.ts");
  const { createHash } = await import("node:crypto");
  const chat = await wireTurn(),
    helper = await wireTurn({ kind: "helper" });
  const observation = (tools: unknown[], helperBlock: boolean) =>
    "LIVE_HELPER_WIRE " +
    JSON.stringify({
      model: "helper-fixture",
      tools: tools.length,
      hash: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
      helperBlock,
    });
  const normal = [observation(chat.wire.tools, false)],
    background = [observation(helper.wire.tools, true)];
  assert.deepEqual(helperWireResult(normal, background), {
    model: "helper-fixture",
    tools: chat.wire.tools.length,
  });
  for (const tools of [
    [],
    helper.wire.tools.slice(1),
    [...helper.wire.tools].reverse(),
  ])
    assert.throws(() => helperWireResult(normal, [observation(tools, true)]));
  assert.throws(() =>
    helperWireResult(normal, [observation(helper.wire.tools, false)]),
  );
  assert.deepEqual(liveTurnHeaders(), {});
  assert.match(liveTurnHeaders(true)["x-iva-helper"], /^h-[0-9a-f]{6}$/);
});
test("R1 incomplete wire observations fail closed", async () => {
  const { helperWireResult } = await import("./live-turn.ts");
  for (const fields of [
    { tools: 140 },
    { tools: "140", hash: "a".repeat(64) },
  ]) {
    const line = (helperBlock: boolean) =>
      "LIVE_HELPER_WIRE " +
      JSON.stringify({ model: "fixture", ...fields, helperBlock });
    assert.throws(() => helperWireResult([line(false)], [line(true)]));
  }
});
