/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type { ToolContext } from "eve/tools";

// Тесты тулов живут в scripts/: файл рядом с тулами eve счёл бы ещё одним тулом и сборка
// упала бы. Хук резолвинга идёт первым — тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";

const dataDir = mkdtempSync(join(tmpdir(), "iva-owner-rules-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const { default: addRuleTool } =
  await import("../agent/tools/instructions_add_rule.ts");
const { default: writeFileTool } = await import("../agent/tools/write_file.ts");
const { default: ownerRulesSource } =
  await import("../agent/instructions/30-owner-rules.ts");
const { ownerRulesMarkdown } = await import("../agent/lib/owner-rules.ts");

type AddRuleAnswer =
  | {
      readonly ok: true;
      readonly path: string;
      readonly rules: number;
      readonly chars: number;
    }
  | { readonly ok: false; readonly error: string };

type WriteFileAnswer =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly path: string; readonly error: string };

// Второй аргумент execute — контекст хода; тестам тулов он не нужен, а eve типизирует
// ответ тула как «значение или поток». Оба тула отвечают значением.
const ctx = {} as unknown as ToolContext;

const addRule = (input: { text: string }) =>
  addRuleTool.execute(input, ctx) as Promise<AddRuleAnswer>;
const writeFile = (input: { path: string; content: string }) =>
  writeFileTool.execute(input, ctx) as Promise<WriteFileAnswer>;

const rulesDir = join(dataDir, "custom", "agent", "instructions");
const rulesPath = join(rulesDir, "rules.md");
const HEADER =
  "# Owner rules\n\nThese rules add to the bundled persona and load every turn.\n\n";

beforeEach(() => {
  rmSync(rulesDir, { recursive: true, force: true });
  rmSync(join(dataDir, "custom/agent/instructions.md"), { force: true });
  rmSync(join(dataDir, "instructions-link"), { force: true });
});

test("a rule added by the tool is in the prompt on the next turn", async () => {
  const first = await addRule({ text: "no emoji" });
  assert.ok(first.ok);
  assert.equal(first.rules, 1);

  const second = await addRule({ text: "one paragraph per reply" });
  assert.ok(second.ok);
  assert.equal(second.rules, 2);
  assert.equal(second.path, rulesPath);
  assert.deepEqual(
    readFileSync(rulesPath),
    Buffer.from(`${HEADER}- no emoji\n- one paragraph per reply\n`, "utf8"),
  );

  writeFileSync(join(rulesDir, "10-tone.md"), "- dry tone\n");
  const markdown = ownerRulesMarkdown(rulesDir);
  assert.ok(markdown.includes("### 10-tone.md"));
  assert.ok(markdown.includes("### rules.md"));
  assert.ok(
    markdown.indexOf("### 10-tone.md") < markdown.indexOf("### rules.md"),
  );
  assert.ok(markdown.includes("- dry tone"));
  assert.ok(markdown.includes("- no emoji"));

  // Проводка: default-экспорт источника отдаёт тот же текст на turn.started.
  const started = ownerRulesSource.events["turn.started"];
  assert.ok(started);
  const instructions = await started({}, {} as never);
  assert.ok(instructions);
  assert.match(JSON.stringify(instructions), /no emoji/u);
  assert.match(JSON.stringify(instructions), /dry tone/u);
});

test("the tool refuses a duplicate, a multi-line rule and a file over the cap", async () => {
  const added = await addRule({ text: "no emoji" });
  assert.ok(added.ok);

  const before = readFileSync(rulesPath);
  const duplicate = await addRule({ text: "no emoji" });
  assert.ok(!duplicate.ok);
  assert.match(duplicate.error, /already/u);
  assert.ok(readFileSync(rulesPath).equals(before));

  const multiline = await addRule({ text: "one\nrule" });
  assert.ok(!multiline.ok);
  assert.match(multiline.error, /one rule/u);
  assert.ok(readFileSync(rulesPath).equals(before));

  // 3 990 + "- " + текст на 20 знаков + перевод строки > 4 000: файл не меняется.
  writeFileSync(rulesPath, "x".repeat(3990));
  const oversized = readFileSync(rulesPath);
  const overCap = await addRule({ text: "y".repeat(20) });
  assert.ok(!overCap.ok);
  assert.match(overCap.error, /4000/u);
  assert.ok(readFileSync(rulesPath).equals(oversized));
});

test("write_file still writes ordinary files under data", async () => {
  const target = join(dataDir, "custom/agent/skills/x.md");
  const answer = await writeFile({ path: target, content: "skill\n" });
  assert.ok(answer.ok);
  assert.equal(readFileSync(target, "utf8"), "skill\n");
});

test("write_file refuses the owner instruction files", async () => {
  mkdirSync(rulesDir, { recursive: true });
  const targets = [
    rulesPath,
    join(dataDir, "custom/agent/instructions.md"),
    join(rulesDir, "10-tone.md"),
  ];
  for (const target of targets) {
    const answer = await writeFile({ path: target, content: "- nope\n" });
    assert.ok(!answer.ok);
    assert.match(answer.error, /instructions_add_rule/u);
    assert.equal(existsSync(target), false);
  }

  // Симлинк на каталог правил — тот же отказ: сравнение идёт по realpath.
  const link = join(dataDir, "instructions-link");
  symlinkSync(rulesDir, link, "dir");
  const viaLink = await writeFile({
    path: join(link, "rules.md"),
    content: "- nope\n",
  });
  assert.ok(!viaLink.ok);
  assert.match(viaLink.error, /instructions_add_rule/u);
  assert.equal(existsSync(rulesPath), false);
});

test("the source stays silent without a directory and with an empty file", () => {
  assert.equal(ownerRulesMarkdown(rulesDir), "");

  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(rulesPath, "");
  assert.equal(ownerRulesMarkdown(rulesDir), "");

  writeFileSync(join(rulesDir, "10-tone.md"), "  \n");
  assert.equal(ownerRulesMarkdown(rulesDir), "");
});
