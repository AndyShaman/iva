// Шум токен-эндпоинта OpenAI (agent/lib/codex-auth.ts): что приходит вместо токена.
//
// ЧТО ЛОМАЕТСЯ У ПОЛЬЗОВАТЕЛЯ. Один 200-ответ без `access_token` (пустой JSON `{}`,
// обрезанное тело, заглушка прокси, 200 от captive portal без JSON-ошибки) затирает
// data/codex-auth.json: доступного токена в файле больше нет, а `refresh_token` остаётся
// НЕПРИКАСНОВЕННЫМ. Первый же запрос к модели уходит с `Authorization: Bearer undefined`,
// следующий вызов getAccessToken видит пустой access_token и бросает «not logged in — run
// iva login» — установка разлогинена навсегда, хотя живой refresh_token лежит в том же файле
// и мог бы восстановить вход сам. 500 и HTML-тело ведут себя честно (ошибка, файл цел) —
// ломает именно «успешный» ответ без токена.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; при провале подставь ещё и path:
// fc.assert(prop, { seed: SEED, path }).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { getAccessToken, readAuth } from "./codex-auth.ts";

const SEED = 20_260_916;
const NOW_S = Math.floor(Date.now() / 1000);

function jwt(payload: number | Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(typeof payload === "number" ? { exp: payload } : payload)}.sig`;
}

/** Установка с истёкшим (но настоящим) входом: refresh_token на месте. */
function install(): { dir: string; file: string; before: string } {
  const dir = mkdtempSync(join(tmpdir(), "iva-codex-chaos-"));
  const file = join(dir, "codex-auth.json");
  const before = JSON.stringify({
    access_token: jwt(NOW_S - 60),
    refresh_token: "rt-original",
    accountId: "acc-1",
    planType: "plus",
  });
  writeFileSync(file, before);
  return { dir, file, before };
}

function stubTokenEndpoint(body: string, status: number): void {
  globalThis.fetch = () => Promise.resolve(new Response(body, { status }));
}

await test("любой ответ токен-эндпоинта либо даёт живой токен, либо честно падает (seed 20260916)", async () => {
  const bodies = fc.oneof(
    fc.constant('{"access_token":null}'),
    fc.constant('{"access_token":""}'),
    fc.constant('{"access_token":0}'),
    fc.constant('{"access_token":{}}'),
    fc.constant('{"refresh_token":"rt-next"}'),
    fc.constant("{}"),
    fc.json({ maxDepth: 2 }),
    fc.string({ maxLength: 60 }),
  );
  const statuses = fc.constantFrom(200, 201, 400, 401, 429, 500, 503);

  await fc.assert(
    fc.asyncProperty(statuses, bodies, async (status, body) => {
      const { dir, file, before } = install();
      stubTokenEndpoint(body, status);
      try {
        let token: { accessToken: string } | null = null;
        try {
          token = await getAccessToken(dir);
        } catch {
          // Явный отказ — честный исход: файл входа обязан остаться прежним.
          assert.equal(
            readFileSync(file, "utf8"),
            before,
            "отказ обязан не трогать файл входа",
          );
          return;
        }
        assert.ok(
          typeof token.accessToken === "string" && token.accessToken.length > 0,
          `провайдеру уехал пустой токен: ${JSON.stringify(token.accessToken)}`,
        );
        const stored = readAuth(dir);
        assert.ok(
          typeof stored?.access_token === "string" &&
            stored.access_token.length > 0,
          "после успешного ответа файл входа остался без access_token",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
    { seed: SEED, numRuns: 200 },
  );
});

await test("минимальный контрпример: 200 с пустым JSON вытирает вход навсегда (seed 20260916)", async () => {
  const { dir, file } = install();
  stubTokenEndpoint("{}", 200);
  try {
    // Первый вызов и есть поломка: провайдеру уезжает пустой токен, а файл теряет вход.
    const first = await getAccessToken(dir);
    assert.ok(
      typeof first.accessToken === "string" && first.accessToken.length > 0,
      `провайдеру уехал пустой токен: ${JSON.stringify(first.accessToken)}`,
    );

    // Эндпоинт ожил: следующий вызов обязан войти заново из живого refresh_token.
    stubTokenEndpoint(JSON.stringify({ access_token: jwt(NOW_S + 3600) }), 200);
    const second = await getAccessToken(dir);
    assert.ok(
      second.accessToken.length > 0,
      "установка осталась без входа, хотя refresh_token в файле жив",
    );
    assert.equal(readFileSync(file, "utf8").includes("rt-original"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

