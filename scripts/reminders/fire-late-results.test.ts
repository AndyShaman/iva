// Приёмочные тесты слепого QA (qa-t17.md, блокеры 1 и 2), перенесённые в ветку как
// обычные тесты. Блокер 1: поздний успех прямой отправки не даёт второго сообщения —
// ветка агента ждёт завершения ветки отправки, а не гонку на 10 секунд. Блокер 2:
// результат старого срока повторяющегося напоминания не переписывает факт нового.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const ROOT = mkdtempSync(join(tmpdir(), "iva-reminder-late-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "bootstrap");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });

const { add, fireDue, list } = await import("#lib/reminder-store.ts");
const { runReminderFire } = await import("./fire.ts");

beforeEach(() => {
  process.env.ASSISTANT_DATA_DIR = mkdtempSync(join(ROOT, "case-"));
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

type Ack = { ok: boolean; fellBack: boolean; error: string };

const success = (): Ack => ({ ok: true, fellBack: false, error: "" });
const completed = (message: string) => () =>
  Promise.resolve({
    status: "completed" as const,
    message,
    feedback: () => Promise.resolve(undefined),
  });

const deps = (over: Record<string, unknown>) => ({
  env: {
    TELEGRAM_BOT_TOKEN: "fake-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "fake-bearer",
  } as NodeJS.ProcessEnv,
  chat: () => "555",
  translator: () => Promise.resolve((english: string) => english),
  log: () => {},
  ...over,
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
}

void test("BLOCKER: late Telegram success must not produce a second reminder message", async () => {
  const now = 1_800_000_000_000;
  await add({
    id: "late-success",
    text: "позвонить в клинику",
    schedule: { kind: "at", atMs: now },
  });
  await fireDue(now, 10);

  let finishOriginal!: (ack: Ack) => void;
  const original = new Promise<Ack>((resolve) => {
    finishOriginal = resolve;
  });
  const sent: string[] = [];
  const send = (_bot: string, _chat: string, text: unknown): Promise<Ack> => {
    sent.push(String(text));
    return sent.length === 1 ? original : Promise.resolve(success());
  };

  const firing = runReminderFire(
    "late-success",
    deps({
      send,
      runTurn: completed("Резервное напоминание от агента"),
      // Двойник убирает 10-секундную паузу гонки: с ней баг воспроизводился бы
      // только через реальные 10 секунд, а проверяем мы исход.
      sleep: () => Promise.resolve(),
    }),
  );
  await waitFor(() => sent.length === 2);
  finishOriginal(success());
  await firing;

  assert.deepEqual(
    sent,
    ["позвонить в клинику"],
    "поздний успех исходной отправки пришёл после fallback и дал два сообщения",
  );
});

void test("BLOCKER: a late result from the previous Routine occurrence must not overwrite the latest fact", async () => {
  const now = 1_800_000_000_000;
  await add({
    id: "routine",
    text: "проверить отчёт",
    schedule: { kind: "cron", expr: "*/10 * * * *", tz: "UTC" },
    nextRunAtMs: now,
  });
  const [firstOccurrence] = await fireDue(now, 10);
  assert.ok(firstOccurrence);

  let finishFirst!: (ack: Ack) => void;
  const firstAck = new Promise<Ack>((resolve) => {
    finishFirst = resolve;
  });
  let firstStarted = false;
  const firstRun = runReminderFire(
    "routine",
    deps({
      send: () => {
        firstStarted = true;
        return firstAck;
      },
      runTurn: completed(""),
    }),
  );
  await waitFor(() => firstStarted);

  const [secondOccurrence] = await fireDue(firstOccurrence.nextRunAtMs, 10);
  assert.ok(secondOccurrence);
  await runReminderFire(
    "routine",
    deps({ send: () => Promise.resolve(success()), runTurn: completed("") }),
  );
  assert.equal(
    (await list())[0]?.delivered,
    true,
    "второй срок завершился успешно",
  );

  finishFirst({
    ok: false,
    fellBack: false,
    error: "first occurrence failed late",
  });
  await firstRun;
  const [final] = await list();
  assert.equal(final?.firedAt, secondOccurrence.firedAt);
  assert.equal(
    final?.delivered,
    true,
    `старый результат переписал факт нового срока: ${JSON.stringify(final)}`,
  );
  assert.equal(final?.error, null);
});
