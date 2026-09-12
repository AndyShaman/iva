/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Дневной сторож (T20 п.4): одно сообщение в сутки, когда провалы есть, а агент молчит.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { jobFactsFile, recordFact, type JobFact } from "#lib/job-facts.ts";
import {
  WATCHDOG_SEND_INTERVAL_MS,
  readWatchdogState,
  runJobWatchdog,
  watchdogDecision,
  watchdogMessage,
  watchdogStateFile,
} from "./job-watchdog.ts";

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const tr = (_en: string, ru: string) => ru;

function fact(overrides: Partial<JobFact> = {}): JobFact {
  return {
    name: "memory-daily",
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 1000,
    ok: false,
    error: "exited 1",
    exitCode: 1,
    tail: "",
    acked: false,
    wake: null,
    ...overrides,
  };
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), "t20-watchdog-"));
}

test("провал есть, ходов нет — одно сообщение с числом и doctor", () => {
  assert.equal(
    watchdogMessage([{ source: "job", name: "x", at: NOW, reason: "r" }], tr),
    "за сутки 1 провалов расписаний, агент не отвечает; iva doctor",
  );
  const message = watchdogDecision({
    facts: [fact()],
    now: NOW,
    lastSentAt: null,
    tr,
  });
  assert.match(message ?? "", /1 провалов/u);
  assert.match(message ?? "", /iva doctor/u);
});

test("состоявшийся ход агента (в том числе пустой) отменяет страховку", () => {
  for (const status of ["answered", "empty"] as const) {
    assert.equal(
      watchdogDecision({
        facts: [fact({ wake: { at: NOW - HOUR, status, error: null } })],
        now: NOW,
        lastSentAt: null,
        tr,
      }),
      null,
      status,
    );
  }
  assert.match(
    watchdogDecision({
      facts: [
        fact({
          wake: { at: NOW - HOUR, status: "failed", error: "turn stuck" },
        }),
      ],
      now: NOW,
      lastSentAt: null,
      tr,
    }) ?? "",
    /не отвечает/u,
    "провал пробуждения — агент не отвечает",
  );
});

test("без провалов и после отправки сообщения не шлём", () => {
  assert.equal(
    watchdogDecision({
      facts: [fact({ ok: true, error: null })],
      now: NOW,
      lastSentAt: null,
      tr,
    }),
    null,
  );
  assert.equal(
    watchdogDecision({
      facts: [fact()],
      now: NOW,
      lastSentAt: NOW - HOUR,
      tr,
    }),
    null,
    "не чаще одного в сутки",
  );
  assert.match(
    watchdogDecision({
      facts: [fact()],
      now: NOW,
      lastSentAt: NOW - WATCHDOG_SEND_INTERVAL_MS - HOUR,
      tr,
    }) ?? "",
    /провалов/u,
    "сутки прошли — можно снова",
  );
});

test("запуск сторожа: отправка один раз, состояние пишется после успеха", async () => {
  const dataDir = dir();
  await recordFact(jobFactsFile(dataDir), fact(), NOW);
  const sent: string[] = [];
  const first = await runJobWatchdog({
    dataDir,
    tr,
    send: (text) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    now: () => NOW,
    log: () => {},
  });
  assert.match(first ?? "", /провалов/u);
  assert.equal(sent.length, 1);
  assert.equal(readWatchdogState(watchdogStateFile(dataDir))?.lastSentAt, NOW);

  const second = await runJobWatchdog({
    dataDir,
    tr,
    send: () => {
      throw new Error("must not send twice");
    },
    now: () => NOW + HOUR,
    log: () => {},
  });
  assert.equal(second, null);
});

test("неудачная отправка не отмечается — следующий прогон повторит", async () => {
  const dataDir = dir();
  await recordFact(jobFactsFile(dataDir), fact(), NOW);
  const retried = await runJobWatchdog({
    dataDir,
    tr,
    send: () => Promise.resolve(false),
    now: () => NOW,
    log: () => {},
  });
  assert.match(retried ?? "", /провалов/u);
  assert.equal(readWatchdogState(watchdogStateFile(dataDir)), null);
});

test("битое состояние сторожа — явная ошибка, нет файла — null", () => {
  const file = join(dir(), "jobs-watchdog.json");
  assert.equal(readWatchdogState(file), null);
  writeFileSync(file, "{");
  assert.throws(() => readWatchdogState(file), /damaged/u);
  writeFileSync(file, JSON.stringify({ lastSentAt: "вчера" }));
  assert.throws(() => readWatchdogState(file), /not a watchdog state/u);
});

test("точка входа watchdog.ts шлёт владельцу кодом через тот же сторож", () => {
  const entry = readFileSync(
    fileURLToPath(new URL("../jobs/watchdog.ts", import.meta.url)),
    "utf8",
  );
  assert.match(entry, /runJobWatchdog\(/u);
  assert.match(entry, /sendTelegramHtml\(/u);
});
