/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns registrations. */
import "../../scripts/fixtures/no-host-anthropic.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  modelAuthFailure,
  modelAuthText,
  modelAuthRecoveryText,
} from "./model-auth.ts";

test("Claude CLI, Codex and API authentication failures share one classifier", () => {
  for (const message of [
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "not signed in",
    "run /login",
    "invalid x-api-key",
  ])
    assert.equal(modelAuthFailure(new Error(message), "claude"), "claude");
  for (const message of [
    "CODEX_AUTH_EXPIRED",
    'token refresh failed: 400 {"error":"invalid_grant"}',
    "not logged in — run iva login",
  ])
    assert.equal(modelAuthFailure(message, "codex"), "codex");
  assert.equal(
    modelAuthFailure({ statusCode: 401 }, "openrouter"),
    "openrouter",
  );
  assert.equal(
    modelAuthFailure(
      { statusCode: 403, message: "invalid token" },
      "openrouter",
    ),
    "openrouter",
  );
  assert.equal(
    modelAuthFailure(
      { statusCode: 403, message: "region unavailable" },
      "openrouter",
    ),
    null,
  );
});

test("non-auth statuses and network failures never become authentication alerts", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(429, 500, 503, 408, 402, 400),
      fc.string(),
      (statusCode, noise) => {
        assert.equal(
          modelAuthFailure(
            { statusCode, message: `fetch failed timeout ECONNRESET ${noise}` },
            "openrouter",
          ),
          null,
        );
      },
    ),
    { seed: 231023, numRuns: 200 },
  );
  for (const message of [
    "429 invalid API key",
    "503 OAuth session expired",
    "socket hang up",
    "timeout",
    "400 bad request",
    "403 forbidden",
  ])
    assert.equal(modelAuthFailure(message, "claude"), null);
});

test("authentication text gives provider-specific repair commands in ru and en", () => {
  assert.match(modelAuthText("claude", "ru"), /claude auth login/u);
  assert.match(modelAuthText("codex", "en"), /iva login/u);
  assert.match(modelAuthText("openrouter", "ru"), /замените ключ в \/menu/u);
  assert.doesNotMatch(modelAuthText("claude", "en"), /[а-яё]/iu);
});

test("generated authentication errors remain recognizable through details and network prose", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("claude", "codex", "openrouter"),
      fc.stringMatching(/^[a-zA-Z _-]{0,40}$/u),
      (provider, noise) => {
        const message =
          provider === "claude"
            ? "Failed to authenticate: OAuth session expired"
            : provider === "codex"
              ? "token refresh failed: 400 invalid_grant"
              : "HTTP 403 invalid token";
        assert.equal(
          modelAuthFailure(
            {
              message: "model call failed",
              details: JSON.stringify({
                apiErrorMessage: `${noise} ${message} network timeout`,
              }),
            },
            provider,
          ),
          provider,
        );
      },
    ),
    { seed: 231024, numRuns: 200 },
  );
});

test("ClaudeCliError name identifies the provider even without configured Claude", () => {
  assert.equal(
    modelAuthFailure(
      { name: "ClaudeCliError", message: "Failed to authenticate" },
      "custom",
    ),
    "claude",
  );
});

test("English recovery separates catch-up and remaining-job instructions", () => {
  assert.match(
    modelAuthRecoveryText("claude", "en", ["memory-night", "proactive"]),
    /next run\. Check the remaining/u,
  );
});
