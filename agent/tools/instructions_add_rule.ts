import { defineTool } from "eve/tools";
import { z } from "zod";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/fs-atomic.js";
import {
  OWNER_RULES_CAP,
  RULES_FILE,
  ownerRulesDir,
  readOwnerRules,
} from "../lib/owner-rules.ts";

const HEADER =
  "# Owner rules\n\nThese rules add to the bundled persona and load every turn.\n\n";

export type InstructionsAddRuleAnswer =
  | {
      readonly ok: true;
      readonly path: string;
      readonly rules: number;
      readonly chars: number;
    }
  | { readonly ok: false; readonly error: string };

function ruleCount(contents: string): number {
  return contents.split("\n").filter((line) => line.startsWith("- ")).length;
}

function failure(error: unknown): InstructionsAddRuleAnswer {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export default defineTool({
  description:
    "Записать правило поведения владельца: одна строка дописывается в data/custom/agent/instructions/rules.md " +
    "и действует со следующего хода, без сборки и рестарта. " +
    "Для постоянных фактов, предпочтений и целей пользователя - CORE через write_file, " +
    "для стиля общения - квиз в /menu. " +
    "Файлы правил напрямую не пиши: data/custom/agent/instructions/ пишет только этот инструмент.",
  inputSchema: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe("Правило одной строкой, словами владельца"),
  }),
  async execute({ text }): Promise<InstructionsAddRuleAnswer> {
    // Одно правило — одна строка: многострочный текст развалил бы список.
    if (text.includes("\n") || text.includes("\r"))
      return {
        ok: false,
        error: "one rule = one line: a rule cannot contain a line break",
      };
    const dir = ownerRulesDir();
    const { files, chars } = readOwnerRules(dir);
    const existing = files.find((file) => file.name === RULES_FILE);
    const current = existing?.body ?? HEADER;
    const line = `- ${text}`;
    if (current.split("\n").includes(line))
      return { ok: false, error: `the rule is already there: ${line}` };
    const next = `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
    const total = chars - (existing?.body.length ?? 0) + next.length;
    if (total > OWNER_RULES_CAP)
      return {
        ok: false,
        error: `owner rules would be ${total} chars, over the ${OWNER_RULES_CAP} cap: shorten the rule or move the long part into a skill`,
      };
    const path = join(dir, RULES_FILE);
    try {
      await writeFileAtomic(path, next);
    } catch (error) {
      return failure(error);
    }
    return { ok: true, path, rules: ruleCount(next), chars: total };
  },
});
