# Extending

Everything Iva does is a file in an `agent/` tree. The shipped files in `agent/` are the authored tree,
refreshed by releases; your custom layer lives in `data/custom/agent/`. `npm run build` combines both in
a disposable tree, then `iva restart` activates the result ([cli.md](./cli.md)). The live source checkout
stays clean, so an update cannot be blocked by a customized skill or HTML file. Local edits you already
made to `agent/instructions.md`, `agent/connections/`, `agent/tools/` or `agent/subagents/` move into
the custom layer automatically on the first update. Skills are the exception: they are read straight
off disk at run time and never go through a build (see below). Edits anywhere else in
the tree stay a plain local patch: the updater stashes them and replays them onto the new revision, and
archives them under `data/update-conflicts/` when they no longer apply.

A capability can also arrive packaged: a plugin is a folder with skills, code and MCP servers
that installs with one command and leaves with another, into the same custom layer. This page is
what you write yourself; plugins are [plugins.md](plugins.md).

## Adding a skill

Skills are markdown procedures in `data/custom/agent/skills/` that the model loads on demand. The
frontmatter `description` is the only part the model sees before loading - write it as a trigger
condition ("Use when…"), not a summary. Two shapes work: a flat `<name>.md`, or a `<name>/` directory
with a `SKILL.md` plus supporting files. Iva loads both your custom skills and the bundled skills in
`agent/skills/`; bundled skills are read-only templates, simplest first:

- 📋 **morning-digest.md** — one tool call (`tasks`), grouping rules, output format. Copy this for any "call a tool, format the result" job.
- 🔎 **web-research.md** — a 4-step chain: `web_search` → pick 2–4 sources → `web_fetch` each → synthesize with links.
- 🌐 **agent-browser/** — directory skill wrapping a CLI the model drives through `bash`.
- 🛡 **security-defense/** — a procedure plus data: `SKILL.md`, a patterns file for reviewing a command by eye, and the secret-key inventory the runtime gate reads.
- 📮 **google-workspace.md** — one CLI surface covering Gmail, Calendar, Drive, Sheets, Docs and Tasks.
- 📄 **documents.md** — local PDF, DOCX and XLSX extraction, one-file answers and optional library import.
- 📡 **telegram-userbot/** — a guarded personal-account workflow with a separate safety reference.
- 🎨 **rich-post/** — rich Telegram posts to another allowlisted chat; the sending is the `iva post` command, not a bundled script.
- 🩹 **update-recovery/** — merges customizations an update left in `data/update-conflicts/`; triggered by "restore my update changes".

A new skill needs no build: Iva reads `data/custom/agent/skills/` at the start of every turn, so a file
written during a conversation is loadable on the next one. A skill that shares its name with a bundled
one replaces it. The skills of an installed plugin are read the same way, and yours here win over
theirs ([plugins.md](plugins.md)). Tools, connections, subagents and instructions are code that goes into the bundle -
those still need `iva update`.

⚠️ Your skills go in `data/custom/agent/skills/` and nowhere else - never in a `.claude/` directory
(`~/.claude/skills/`, `vault/.claude/skills/`). That is a different tool's layout; Iva does not read it.

If Iva should reach for your skill unprompted, name it in a file under
`data/custom/agent/instructions/`.

## MCP connections

Drop `data/custom/agent/connections/<name>.ts` - the filename becomes the connection name.
`agent/connections/example.ts.txt` is the inert bundled template (the `.txt` suffix keeps eve from
loading it half-configured):

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/sse", // Streamable HTTP or SSE endpoint
  description: "What this server does — the model reads this.",
  auth: {
    getToken: async () => ({ token: process.env.EXAMPLE_MCP_TOKEN ?? "" }),
  },
  // tools: { allow: ["search", "get_item"] },  // optional: restrict, add approval
});
```

The model discovers the server's tools through the built-in `connection_search` and calls them as `connection__<name>__<tool>`. The URL and token stay on the runtime side: keys live in `.env` and are never visible to the model.

## Custom tools

Put a tool in `data/custom/agent/tools/<name>.ts`. Use the bundled files in `agent/tools/` as
read-only examples. Every input must have a zod schema, enum-like values need explicit allowlists,
and file paths must be resolved and bounded to their permitted root. Keep credentials in `.env`.
The disposable build compiles custom tools together with the authored tree's tools without copying their
source into the live checkout.

## Subagents

A subagent is `data/custom/agent/subagents/<name>/` with an `agent.ts` and its own `instructions.md`.
The bundled `agent/subagents/planner` is the pattern: its `description` tells the main agent when to
delegate ("break a large goal into steps"), and a zod `outputSchema` forces a structured, validated
reply instead of prose:

```ts
outputSchema: z.object({
  goal: z.string(),
  steps: z.array(z.object({
    title: z.string(), detail: z.string(), priority: z.enum(["low", "med", "high"]),
  })),
}),
```

A subagent runs on the main provider: the planner takes its model straight from `agent/provider.ts`, so `MODEL_PROVIDER` picks the model for every node of the graph at once. Subagents deliberately keep no provider or env of their own — one selection, one identity, one usage line.

## Changing the character

Iva's voice comes from two places under `data/custom/agent/`:

- `data/custom/agent/instructions.md` **replaces** the bundled `agent/instructions.md` whole: tone,
  rules, tool preferences and hard limits. Start by copying the bundled file. If an upstream edit
  overlaps yours, Iva merges the three versions (base, yours, upstream); a full rewrite conflicts.
  The reply language still comes from `AGENT_LANGUAGE` in `.env`.
- `data/custom/agent/instructions/<name>.md` (or a dynamic `<name>.ts`, like the bundled
  `agent/instructions/20-core.ts`: only `eve`, local packages and node `fs`/`path`) **adds** to the
  bundled blocks. It loads after the bundled persona, next to `agent/instructions/*`. A name already
  taken by a bundled file is refused by the build with the path — rename the file.

Both paths are code that goes into the bundle: `npm run build`, or `iva update`. On an installation
that runs built versions, the slot arrives with the first build made by the new CLI — run
`iva update --force` once after updating to the release that ships it. The bundled files in
`agent/instructions/` stay upstream and are refreshed by releases; the slot only adds next to them.

If an upstream edit overlaps yours, Iva activates the new authored tree and saves all three versions
(base, yours, upstream) under `data/update-conflicts/`. Tell Iva "restore my update changes" or «верни
мои изменения после обновления» to load the recovery skill and merge them from chat.

What Iva knows about _you_ is memory, not code — that's `CORE.md` in the vault ([memory.md](./memory.md)).

### Moving a replaced persona into the slot

`data/custom/agent/instructions.md` replaces the bundled persona whole. That was the only way to
add a rule of your own, and it has a cost: your copy froze on the day you made it, and every rule
shipped since then — reminders, delivery, the tool policy — never reaches the model. The slot
(`data/custom/agent/instructions/<name>.md`) adds instead of replacing, so the bundled persona
keeps arriving with each release and your rules ride next to it.

**The symptom.** Iva ignores something the release notes say she now does: she offers a shell timer
instead of the reminder tool, or sends a report with her own script instead of answering. Check in
one line — the first grep reads the persona that is actually in the build, the second reads the file
you wrote:

```bash
grep -c "Reminders and schedules" ~/iva/current/agent/instructions.md   # Version install
grep -c "Reminders and schedules" data/custom/agent/instructions.md
```

If the bundled heading is missing from both, your replacement is what the model sees, and it predates
that block. (On a checkout install read `agent/instructions.md` in the checkout instead of
`~/iva/current/...`.)

**1. Diff your file against the base it replaced.** Iva keeps that base: the manifest records which
blob your file was built from, and the blob sits next to it. This is the same pair the merge machinery
uses, so it is the honest "before":

```bash
cd ~/iva            # or your checkout
base=$(node -e 'const m=require("./data/custom/manifest.json");console.log(m.entries["agent/instructions.md"].baseBlob)')
diff -u "data/custom/bases/$base" data/custom/agent/instructions.md
```

Everything that diff prints as added is yours; everything it prints as context is the bundled persona
of that day. If the manifest has no entry yet (you created the file but never built), diff against the
bundled file of the release you run instead.

**2. Keep only what the diff calls yours.** Sort the additions into three piles:

- **Keep** — red lines and preferences no release can know: how a report must look, tone, which tool
  you want reached for first, hosts and paths peculiar to your machine, personal integrations
  (a proxy of yours, a CLI of yours) with their exact command.
- **Drop** — anything the bundled persona already says. It is the whole point of the move: blocks
  like tone-of-voice boilerplate, "what you can do", background-process rules come back for free and
  stay current.
- **Drop** — recipes that have since become wrong: a script that sends to Telegram itself, a shell
  timer, a command that was removed, a hard-coded list of commands. If a rule of yours names a tool,
  check the tool still exists before carrying it over.

Write what is left into `data/custom/agent/instructions/rules.md` (any name that is not already taken
by a bundled file in `agent/instructions/`; a collision is refused by the build with the path). Open
it with one sentence saying it adds to the bundled persona — the model reads the file without any
context about where it came from.

**3. Remove the replacement and rebuild.** The slot only works once the replacement is gone;
otherwise the frozen copy still wins for the base file:

```bash
cp data/custom/agent/instructions.md ~/instructions.md.backup   # keep an exit
rm data/custom/agent/instructions.md
```

On an installation that runs built versions (`~/iva/versions/` with a `current` symlink):

```bash
iva update --force     # a plain `iva update` with no new commits would do nothing
```

On a checkout installation:

```bash
npm run build
```

then `/restart` in the chat.

**4. Check the result.** Two greps and one question. The greps prove the bundled persona came back
and your file is in the build:

```bash
grep -c "Reminders and schedules" ~/iva/current/agent/instructions.md   # 1
grep -c "" ~/iva/current/agent/instructions/rules.md                    # your file, line count
```

Then ask Iva, in the chat, one question that only the bundled rules answer ("how do you set a
reminder for tomorrow at nine?" — she must name the reminder tool, not a shell timer) and one that
only your file answers ("what are your rules for reports?"). Both answers right means the two halves
are live at once.

**5. Roll back if something is off.** On a version install `iva rollback` flips back to the version
that ran before — no build, no network. To go back to the replacement instead, restore your backup
and rebuild:

```bash
cp ~/instructions.md.backup data/custom/agent/instructions.md
rm data/custom/agent/instructions/rules.md
iva update --force      # or npm run build + /restart on a checkout
```

## Local development

```bash
npm ci        # postinstall applies patches/eve+0.51.1.patch
npm run dev   # eve dev TUI, server on http://127.0.0.1:2000
npm run build:core  # maintainer build of the current source tree
npm exec -- eve dev --no-ui --logs all   # headless
```

The TUI is a full chat — skills, tools and subagents all work without Telegram. To smoke-test the tool loop from a script, drive the dev server with `eve/client`:

```js
import { Client } from "eve/client";
const session = new Client({ host: "http://127.0.0.1:2000" }).session();
const res = await session.send("Add a task: buy coffee, high priority.");
console.log((await res.result()).message);
```

One gotcha — Iva runs eve **0.51.1**:

- 🩹 **patch-package** — `patches/eve+0.51.1.patch` makes deterministic model-call errors (invalid prompt, unknown tool) fail fast instead of parking a poisoned session. It also preserves the structured HTTP status from `web_fetch`, keeps the dynamic "Available skills" announcement in the system prompt instead of a user message, and falls back to `/workspace/skills` when the sandbox reports `HOME=/` (upstream vercel/eve#2839, PR #2841; contract test `scripts/eve-skill-announcement.test.ts`). If you bump Eve, regenerate the patch or drop each edit only after its targeted contract test passes against upstream.

The Eve 0.11.4 schedule crash (`eve dev` dying when a schedule handler imported another authored module) is fixed since 0.27.8. Iva now ships five `agent/schedules/*.ts` handlers: four memory rollups and the opt-in digest. On a VPS they run in the `iva.service` process; the two remaining systemd timers are watchdogs for the nightly Brain pass and update-check ([deploy.md](./deploy.md)).
