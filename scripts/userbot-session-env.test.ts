import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import fc from "fast-check";

void test("userbot session labels preserve names and reject invalid labels (seed 20261020)", () => {
  const python = process.env.IVA_USERBOT_TEST_PYTHON ?? "python3";
  const valid = fc.stringMatching(/^[a-z0-9_]{1,16}$/);
  fc.assert(
    fc.property(
      fc.array(fc.oneof(valid, fc.string({ maxLength: 16 })), {
        maxLength: 12,
      }),
      (labels) => {
        const directory = mkdtempSync(join(tmpdir(), "iva-userbot-labels-"));
        try {
          const safeLabels = labels.filter(
            (label) => !label.includes("/") && !label.includes("\0"),
          );
          writeFileSync(join(directory, "telegram-userbot.session"), "");
          for (const label of safeLabels)
            writeFileSync(
              join(directory, `telegram-userbot-${label}.session`),
              "",
            );
          const result = spawnSync(
            python,
            [
              "-c",
              [
                "import json, os, serve",
                "serve._seed_session_env()",
                "print(json.dumps({k: v for k, v in os.environ.items() if k.startswith('TELEGRAM_SESSION_')}))",
              ].join("\n"),
            ],
            {
              encoding: "utf8",
              env: {
                PATH: process.env.PATH,
                PYTHONPATH: resolve("services/telegram-userbot"),
                ASSISTANT_DATA_DIR: directory,
              },
            },
          );
          assert.equal(result.status, 0, result.stderr);
          const sessions = JSON.parse(result.stdout) as Record<string, string>;
          const expected = new Set([
            "default",
            ...safeLabels.filter(
              (label) => /^[a-z0-9_]+$/.test(label) && label !== "default",
            ),
          ]);
          if (expected.size === 1) {
            assert.deepEqual(sessions, {
              TELEGRAM_SESSION_NAME: join(directory, "telegram-userbot"),
            });
          } else {
            assert.equal(sessions.TELEGRAM_SESSION_NAME, undefined);
            assert.deepEqual(
              new Set(Object.keys(sessions)),
              new Set(
                [...expected].map(
                  (label) => `TELEGRAM_SESSION_NAME_${label.toUpperCase()}`,
                ),
              ),
            );
            for (const label of expected)
              assert.equal(
                sessions[`TELEGRAM_SESSION_NAME_${label.toUpperCase()}`],
                join(
                  directory,
                  `telegram-userbot${label === "default" ? "" : `-${label}`}`,
                ),
              );
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    ),
    { seed: 20261020, numRuns: 60 },
  );
});
