// `iva diagnose` — один пакет улик для issue или группы поддержки. Два контракта:
//  1) `redact` — чистая функция: в результате не остаётся ни одного секрета (property),
//     плюс примеры на токен бота, chat id владельца и e-mail;
//  2) команда на фикстуре каталога данных: файл создан, все разделы на месте, а значения
//     фикстурного .env, текст напоминания, содержимое карточки и текст ошибки хода в пакет
//     не попали. Доктор внутри зовётся настоящий — он и есть половина улик.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; при провале подставь ещё и path:
// fc.assert(prop, { seed: SEED, path }).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { REDACTED, createDiagnoseCommand } from "./diagnose.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };
const NOW = new Date("2026-09-12T15:04:07.000Z");
const TOKEN = "123456789:AAF3xK9mQ7vR2sT5uW8yZ1bC4dE6fG0hI2j";
const OWNER_ID = "987654321";
const BEARER = "Bq7".repeat(15);
const SUPPORT_URL = "https://t.me/+iva-support-chat";
const REMINDER_TEXT = "напомни про подарок для Ани";
// Токен, которого нет в .env: его обязан поймать шаблон, а не список значений.
const FOREIGN_TOKEN = "444555666:BBForeignTokenJJJabcdefghijklmnopqrs";
const CARD_TEXT = "в карточке лежит секретное содержимое";
const FAILURE_MESSAGE = "секретное сообщение о провале хода";

function lifecycle(): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    retireDeferredBrainUnits: () => [],
    retireLegacyMemoryUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
  };
}

async function sandbox(t: TestContext): Promise<{
  root: string;
  data: string;
  env: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-diagnose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output/server"), { recursive: true });
  writeFileSync(join(root, ".output/server/index.mjs"), "export {};\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "iva",
      version: "9.9.9",
      dependencies: { eve: "1.2.3" },
    }),
  );
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const env = {
    MODEL_PROVIDER: "ollama",
    ASSISTANT_DATA_DIR: "data",
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_ALLOWED_USER_IDS: OWNER_ID,
    ASSISTANT_BEARER: BEARER,
    SUPPORT_CHAT_URL: SUPPORT_URL,
    TINY_KEY: "xq7",
  };
  writeFileSync(
    join(root, ".env"),
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return { root, data, env };
}

function runtimeFor(
  root: string,
  data: string,
  env: Record<string, string>,
  printed: string[],
  journal: { code: number; out: string; err: string },
  warnings: string[] = [],
): CliRuntime {
  return {
    ...createCliRuntime(root),
    C: NO_COLOR,
    dataDirAbs: () => data,
    readEnv: () => env,
    hasSystemd: () => false,
    gitHead: () => "abc1234",
    cap: () => journal,
    ok: (message) => void printed.push(message),
    warn: (message) => void warnings.push(message),
  };
}

await test("пакет на фикстуре данных: все разделы, ни одного секрета и текста владельца", async (t) => {
  const { root, data, env } = await sandbox(t);
  const old = NOW.getTime() - 60 * 60 * 1000;
  writeFileSync(
    join(data, "reminders.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      rows: [
        {
          id: "rem-run-failed",
          text: REMINDER_TEXT,
          mode: "verbatim",
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: old + 60_000,
          lastRunAtMs: old,
          lastStatus: "failed",
          lastError: `sendMessage 400: Bad Request: ${REMINDER_TEXT}`,
          deliver: { chatId: OWNER_ID },
          leaseUntilMs: null,
          deliveredKey: null,
        },
        {
          id: "rem-run-ok",
          text: REMINDER_TEXT,
          mode: "agent",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Almaty" },
          nextRunAtMs: NOW.getTime() + 60 * 60 * 1000,
          lastRunAtMs: old + 60_000,
          lastStatus: "ok",
          lastError: null,
          deliver: { chatId: OWNER_ID },
          leaseUntilMs: null,
          deliveredKey: "tg:1",
        },
        {
          id: "rem-overdue",
          text: REMINDER_TEXT,
          mode: "verbatim",
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: old,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          deliver: { chatId: OWNER_ID },
          leaseUntilMs: null,
          deliveredKey: null,
        },
        {
          id: "rem-future-only",
          text: REMINDER_TEXT,
          mode: "verbatim",
          schedule: { kind: "at", atMs: old },
          nextRunAtMs: NOW.getTime() + 2 * 60 * 60 * 1000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          deliver: { chatId: OWNER_ID },
          leaseUntilMs: null,
          deliveredKey: null,
        },
      ],
    })}\n`,
  );
  mkdirSync(join(data, "trace"), { recursive: true });
  writeFileSync(
    join(data, "trace/2026-09-12.jsonl"),
    [
      JSON.stringify({
        ts: "2026-09-12T14:00:00.000Z",
        turn: `tg:${OWNER_ID}:42`,
        session: "s1",
        source: "telegram",
        kind: "eve",
        name: "turn.failed",
        data: { code: "rate_limit", message: FAILURE_MESSAGE },
      }),
      JSON.stringify({
        ts: "2026-09-12T14:30:00.000Z",
        turn: `tg:${OWNER_ID}:43`,
        session: "s1",
        source: "telegram",
        kind: "outbox",
        name: "failed",
        data: {
          ok: false,
          delivered: 0,
          error: FAILURE_MESSAGE,
          errorCode: `LONG_CODE_${"z".repeat(120)}`,
        },
      }),
      JSON.stringify({
        ts: "2026-09-10T10:00:00.000Z",
        turn: "tg:1:1",
        session: "s2",
        source: "telegram",
        kind: "eve",
        name: "turn.failed",
        data: { code: "stale_failure" },
      }),
      "",
    ].join("\n"),
  );
  const logDir = join(data, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "update-2026-09-12T10-00-00-000Z.log"),
    `ASSISTANT_BEARER=${BEARER}\n` +
      `GET https://api.telegram.org/bot${FOREIGN_TOKEN}/sendMessage failed\n`,
  );
  mkdirSync(join(data, "custom/agent/instructions"), { recursive: true });
  mkdirSync(join(data, "custom/agent/skills/my-skill"), { recursive: true });
  writeFileSync(join(data, "custom/agent/instructions/rules.md"), CARD_TEXT);
  writeFileSync(join(data, "custom/agent/skills/my-skill/SKILL.md"), CARD_TEXT);
  const printed: string[] = [];
  const journal = { code: 1, out: "", err: "journalctl not found" };

  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, journal),
    lifecycle(),
    { now: () => NOW },
  )();

  const path = join(data, "diagnose", "2026-09-12T15-04-07-000Z.md");
  assert.deepEqual(printed, [`Diagnose package: ${path}`]);
  assert.ok(existsSync(path), "пакет создан по напечатанному пути");
  const text = readFileSync(path, "utf8");
  for (const section of [
    "# Iva diagnose package",
    "## Versions",
    "## Host",
    "## iva doctor",
    "## Service journal (last 200 lines)",
    "## Reminders (last 24h and overdue)",
    "## Failed turns (last 24h)",
    "## Custom layer (file names only)",
  ])
    assert.ok(text.includes(section), `нет раздела ${section}`);
  assert.match(
    text,
    /- redaction: 7 values from \.env, pattern rules always on/u,
    "пакет обязан сказать, чем и по какому списку он вырезал",
  );
  assert.match(text, /- iva: 9\.9\.9 \(git abc1234\)/);
  assert.match(text, /- eve: 1\.2\.3/);
  assert.match(text, /- node: v\d+/);
  assert.match(text, /Node \d+\.\d+\.\d+/, "в пакете вывод настоящего доктора");
  assert.match(text, /Summary: \d+ ok/);
  assert.ok(
    text.includes("update-2026-09-12T10-00-00-000Z.log"),
    "нет journalctl — взят новейший файл журнала",
  );
  assert.match(
    text,
    /rem-run-failed · due .* · last .* · delivered no · error sendMessage 400/,
  );
  assert.match(text, /rem-run-ok · due .* · delivered yes/);
  assert.match(text, /rem-overdue · due .* · delivered never/);
  assert.ok(
    !text.includes("rem-future-only"),
    "нет фактов и не просрочено — не в пакете",
  );
  assert.match(text, /eve\.turn\.failed · turn .* · code rate_limit/);
  assert.match(text, /outbox\.failed · turn .* · code LONG_CODE_zzzz/);
  assert.ok(
    !text.includes("z".repeat(80)),
    "код ошибки в пакете обязан быть ограничен по длине",
  );
  assert.ok(
    !text.includes("2026-09-10T10:00:00.000Z"),
    "провал старше суток не в пакете",
  );
  assert.ok(text.includes("instructions/rules.md"));
  assert.ok(text.includes("skills/my-skill/SKILL.md"));
  for (const leak of [
    TOKEN,
    FOREIGN_TOKEN,
    "xq7",
    OWNER_ID,
    BEARER,
    SUPPORT_URL,
    REMINDER_TEXT,
    CARD_TEXT,
    FAILURE_MESSAGE,
  ])
    assert.ok(!text.includes(leak), `утечка в пакете: ${leak}`);
  assert.ok(
    text.includes(REDACTED),
    "вырезание оставило пометку, а не пустоту",
  );
});

await test("секрет, записанный .env доктором во время прогона, тоже вырезается", async (t) => {
  const { root, data, env } = await sandbox(t);
  const printed: string[] = [];
  // Доктор правит .env на ходу (в живом прогоне он заводит ASSISTANT_BEARER): список
  // секретов, прочитанный только ДО прогона, выпустил бы свежий ключ в пакет.
  const freshBearer = "FreshBearerFromDoctorAAA999";
  const beforeDoctor = { ...env };
  delete beforeDoctor.ASSISTANT_BEARER;
  const readEnv = (() => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1
        ? beforeDoctor
        : { ...env, ASSISTANT_BEARER: freshBearer };
    };
  })();
  const runtime: CliRuntime = {
    ...runtimeFor(root, data, env, printed, { code: 1, out: "", err: "" }),
    readEnv,
  };

  await createDiagnoseCommand(runtime, lifecycle(), { now: () => NOW })();

  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.ok(
    !text.includes(freshBearer),
    "секрет, записанный доктором во время прогона, уехал в пакет",
  );
  assert.match(text, /- redaction: 7 values from \.env/u);
});

await test("без .env пакет говорит об этом, а шаблонные правила всё равно работают", async (t) => {
  const { root, data, env } = await sandbox(t);
  rmSync(join(root, ".env"), { force: true });
  const logDir = join(data, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "update-2026-09-12T10-00-00-000Z.log"),
    `GET https://api.telegram.org/bot${FOREIGN_TOKEN}/sendMessage 401\n`,
  );
  const printed: string[] = [];
  const warnings: string[] = [];
  const noEnv = { ...env, TINY_KEY: "" };

  await createDiagnoseCommand(
    runtimeFor(
      root,
      data,
      noEnv,
      printed,
      { code: 1, out: "", err: "" },
      warnings,
    ),
    lifecycle(),
    { now: () => NOW },
  )();

  const text = readFileSync(
    join(data, "diagnose", "2026-09-12T15-04-07-000Z.md"),
    "utf8",
  );
  assert.match(
    text,
    /- redaction: \.env not found — only the pattern rules were applied \(bot token, telegram ids, e-mail\); values of keys are NOT in the cut list/u,
    "отсутствие .env обязано быть сказано в пакете, а не молчать",
  );
  assert.ok(
    warnings.some((line) => line.includes("No .env")),
    "команда обязана сказать об этом и в выводе",
  );
  assert.ok(!text.includes(FOREIGN_TOKEN), "шаблон режет токен и без .env");
  assert.ok(text.includes("bot<redacted>/sendMessage"));
});

await test("битые данные не мешают пакету: разделы честно говорят, чего нет", async (t) => {
  const { root, data, env } = await sandbox(t);
  writeFileSync(join(data, "reminders.json"), "{not json");
  const printed: string[] = [];

  await createDiagnoseCommand(
    runtimeFor(root, data, env, printed, {
      code: 1,
      out: "",
      err: "",
    }),
    lifecycle(),
    { now: () => NOW },
  )();

  const path = join(data, "diagnose", "2026-09-12T15-04-07-000Z.md");
  assert.deepEqual(printed, [`Diagnose package: ${path}`]);
  const text = readFileSync(path, "utf8");
  assert.match(text, /- reminders\.json unreadable: /);
  assert.match(text, /the turn journal has nothing/);
  assert.match(text, /journalctl unavailable \(no journalctl on this host\)/);
  assert.match(text, /## Custom layer \(file names only\)\n- \(none\)/);
});
