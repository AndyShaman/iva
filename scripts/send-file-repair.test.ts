import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import inventory from "../agent/skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };

const root = mkdtempSync(join(tmpdir(), "iva-send-file-repair-"));
mkdirSync(join(root, "attachments"));
const saved = { ...process.env };
for (const name of inventory) delete process.env[name];
process.env.TELEGRAM_BOT_TOKEN = "fixtureTransportTokenForQA";
process.env.ASSISTANT_BEARER = "fixtureFileSecretWithPunctuation!#$";
process.env.ASSISTANT_VAULT_DIR = root;
after(() => {
  for (const name of [...inventory, "ASSISTANT_VAULT_DIR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});
const { sendFile } = await import("../agent/tools/send_file.ts");
const secret = process.env.ASSISTANT_BEARER;
const chat = { id: "1", threadId: null };

void test("file value check rejects binary and encoded copies and names the variable (seed 101313)", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(new Response('{"ok":true}'));
  });
  const carriers = [
    Buffer.from(`ASSISTANT_BEARER=${secret}\n\0`),
    Buffer.concat([
      Buffer.from(`ASSISTANT_BEARER=${secret}`),
      Buffer.from([255]),
    ]),
    Buffer.concat([
      Buffer.from([207, 240, 232, 226, 229, 242]),
      Buffer.from(`\nASSISTANT_BEARER=${secret}`),
    ]),
    Buffer.from(`ASSISTANT_BEARER=${secret}`, "utf16le"),
  ];
  // Offset crosses the search chunk boundary; arbitrary binary prefixes exercise every alignment.
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 100 }),
      fc.integer({ min: 0, max: carriers.length - 1 }),
      async (prefix, carrier) => {
        const bytes = Buffer.concat([
          Buffer.from(prefix),
          Buffer.alloc(65500, 255),
          carriers[carrier],
        ]);
        const path = join(root, "attachments", "copy.bin");
        writeFileSync(path, bytes);
        const result = await sendFile({ path }, chat);
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.error, /ASSISTANT_BEARER/u);
        assert.equal(JSON.stringify(result).includes(secret), false);
      },
    ),
    {
      seed: 101313,
      numRuns: 30,
      examples: carriers.map((_, index): [Uint8Array, number] => [
        new Uint8Array(),
        index,
      ]),
    },
  );
  assert.equal(calls, 0);
});

void test("honest documents and unknown key shapes preserve their bytes", async (t) => {
  let document: File | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    (_url: string, init: { body: FormData }) => {
      const value = init.body.get("document");
      assert.ok(value instanceof File);
      document = value;
      return Promise.resolve(new Response('{"ok":true}'));
    },
  );
  const repo = join(import.meta.dirname, "..");
  const sources: [string, Buffer][] = [
    ...["CHANGELOG.md", ".env.example", "docs/security.md"].map(
      (path): [string, Buffer] => [
        path.split("/").at(-1)!,
        readFileSync(join(repo, path)),
      ],
    ),
    [
      "notes.txt",
      Buffer.from(
        "He was the bearer of bad news.\nPassword: ********\nOLLAMA_API_KEY=\nOLLAMA_MODEL=glm-5",
      ),
    ],
    ["unknown.bin", Buffer.from(`\0sk-${"x".repeat(30)}`)],
    [
      "links.json",
      Buffer.from(
        JSON.stringify(
          Array.from(
            { length: 20000 },
            (_, i) => `https://example.com/items/${i}/photo.jpg`,
          ),
        ),
      ),
    ],
  ];
  for (const [name, bytes] of sources) {
    const path = join(root, "attachments", name);
    writeFileSync(path, bytes);
    const started = performance.now();
    assert.equal((await sendFile({ path }, chat)).ok, true, name);
    if (name === "links.json") {
      const ms = performance.now() - started;
      t.diagnostic(`20000 URLs: ${bytes.length} bytes, ${ms.toFixed(2)} ms`);
      assert.ok(ms < 1000);
    }
    assert.ok(document);
    assert.deepEqual(Buffer.from(await document.arrayBuffer()), bytes);
  }
});

void test("50 MiB file check takes less than a second and yields within 50 ms", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const path = join(root, "attachments", "large.bin");
  writeFileSync(path, Buffer.alloc(50 * 1024 * 1024, 97));
  const start = performance.now();
  let last = start;
  let gap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 1);
  let answer;
  try {
    answer = await sendFile({ path }, chat);
  } finally {
    gap = Math.max(gap, performance.now() - last);
    clearInterval(timer);
  }
  const elapsed = performance.now() - start;
  t.diagnostic(
    `50 MiB: ${elapsed.toFixed(2)} ms, max pause ${gap.toFixed(2)} ms, ticks ${ticks}`,
  );
  assert.equal(answer.ok, true);
  assert.ok(elapsed < 1000, `file check took ${elapsed}ms`);
  assert.ok(ticks > 0);
  assert.ok(gap < 50, `event-loop pause ${gap}ms`);
});

void test("placeholder credentials do not reject an ordinary file", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const before = process.env.CUSTOM_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.CUSTOM_API_KEY;
    else process.env.CUSTOM_API_KEY = before;
  });
  const path = join(root, "attachments", "placeholders.txt");
  writeFileSync(
    path,
    "EMPTY NONEMPTY none 1 файл; npm test; https://ollama.com/library " +
      "x".repeat(20),
  );
  for (const value of [
    "EMPTY",
    "none",
    "1",
    "ollama",
    "test",
    "x".repeat(20),
  ]) {
    process.env.CUSTOM_API_KEY = value;
    assert.equal((await sendFile({ path }, chat)).ok, true, value);
  }
});
