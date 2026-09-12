import { appendFileSync } from "node:fs";

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.telegram.org/")) {
    const log = process.env.QA_T17_SEND_LOG;
    if (log) appendFileSync(log, `${String(init?.body ?? "")}\n`);
    return new Response('{"ok":true,"result":{}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;
