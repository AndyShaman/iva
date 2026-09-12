// T20 п.1-2: каждый запуск расписания оставляет факт, а после факта зовётся пробуждение.
// Прогон интеграционный, как в schedule-runner.test.ts: настоящий ребёнок-node с
// --env-file=.env, а пробуждение подменено шпионом.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFacts } from "./job-facts.ts";
import { runScheduledJob } from "./schedule-runner.ts";

async function scaffold(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-runner-facts-"));
  await writeFile(join(root, ".env"), "", "utf8");
  return root;
}

void test("успех: факт записан, пробуждение позвано со startedAt строки", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const woken: Array<[string, number]> = [];

  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wakeImpl: (name, startedAt) => {
      woken.push([name, startedAt]);
    },
    log: () => {},
  });

  assert.equal(result.ok, true);
  const facts = await readFacts(factsPath);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.name, "memory-daily");
  assert.equal(facts[0]?.ok, true);
  assert.equal(facts[0]?.error, null);
  assert.equal(facts[0]?.exitCode, 0);
  assert.deepEqual(woken, [["memory-daily", facts[0]?.startedAt]]);
});

void test("провал: факт с причиной и хвостом, пробуждение всё равно зовётся", async () => {
  const root = await scaffold();
  await writeFile(
    join(root, "fail.ts"),
    'process.stderr.write("boom: card is broken\\n"); process.exit(7);\n',
  );
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  const woken: string[] = [];

  const result = await runScheduledJob({
    name: "digest",
    argv: ["fail.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wakeImpl: (name) => {
      woken.push(name);
    },
    log: () => {},
  });

  assert.equal(result.ok, false);
  const [fact] = await readFacts(factsPath);
  assert.equal(fact?.ok, false);
  assert.equal(fact?.error, "exited 7");
  assert.match(fact?.tail ?? "", /boom: card is broken/u);
  assert.deepEqual(woken, ["digest"]);
});

void test("wake:false пишет факт, но не будит", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  const statusPath = join(root, "data/rollup-status.json");
  const factsPath = join(root, "data/jobs.json");
  await mkdir(join(root, "data"), { recursive: true });
  let woken = 0;

  await runScheduledJob({
    name: "jobs-watchdog",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wake: false,
    wakeImpl: () => {
      woken += 1;
    },
    log: () => {},
  });

  assert.equal((await readFacts(factsPath)).length, 1);
  assert.equal(woken, 0);
});

void test("без factsPath ни факта, ни пробуждения (доставка напоминаний)", async () => {
  const root = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  let woken = 0;

  await runScheduledJob({
    name: "reminder-abc",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    wakeImpl: () => {
      woken += 1;
    },
    log: () => {},
  });

  assert.equal(woken, 0);
});
