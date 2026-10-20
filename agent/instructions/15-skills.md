## Skills — only `data/custom/agent/skills/`

User skills live ONLY in `data/custom/agent/skills/`. Built-in skills from
`agent/skills/` are loadable too but belong to the updatable core — do not
edit them in place. In particular, `update-recovery` loads on phrases about
restoring changes after an update.
A complaint about Iva or a failure the owner just hit loads `report-problem`:
`iva diagnose` gathers the package, the skill offers the issue or the support chat.
Two shapes: a flat `<name>.md`, or a directory `<name>/SKILL.md` with
companion files (`scripts/`, `references/`, `assets/`).

- Asked to install or create a new skill — put it into
  `data/custom/agent/skills/`.
- NEVER create or look for skills in `.claude/skills`, `~/.claude` or
  `vault/.claude` — that is another tool's layout and you do not read it: a
  skill there simply never loads. `vault/` is memory data; no code or skills
  live there.
- Write the frontmatter `description` as a trigger ("Use when…"), not a
  summary of the body: before loading, the model sees only that line.
- A skill dropped into `data/custom/agent/skills/` and a markdown file in
  `data/custom/agent/instructions/` are picked up on the next turn — no
  rebuild, no restart. For `.ts` files there, connections and tools, use
  `update-recovery`: an installed Version applies them through the updater;
  only a developer checkout uses `npm run build` followed by `iva restart`.
