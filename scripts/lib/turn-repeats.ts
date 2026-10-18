import { cutText, insightLine, readTrace, turnRef } from "./turn-failures.ts";

export const TRACE_REPEAT_BYTES_PER_FILE = 1024 * 1024;
const DAY = 86_400_000,
  WINDOW = 30 * 60_000;
const READING_HEADS = new Set(
  "cat,head,tail,less,more,rg,grep,ls,pwd,find,wc,sed,awk,iva trace,iva diagnose".split(
    ",",
  ),
);
type Data = Record<string, unknown>;
type Line = ReturnType<typeof readTrace>["lines"][number];
const record = (v: unknown): Data =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Data) : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const number = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const clean = (v: unknown) => cutText(text(v).replace(/\s+/gu, " ").trim(), 60);
const at = (line: Line) => Date.parse(text(line.ts));
const isEvent = (line: Line, event: string) =>
  `${text(line.kind)}.${text(line.name)}` === event;
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const dataFor = (events: Line[], kind: string) =>
  events.filter((line) => isEvent(line, kind)).map((line) => record(line.data));
function group<T>(values: T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value),
      items = groups.get(k) ?? [];
    items.push(value);
    groups.set(k, items);
  }
  return groups;
}

function actionHead(value: unknown, input: unknown): string {
  const action = record(value),
    args = record(input),
    name = text(action.toolName);
  if (action.kind === "load-skill" || name === "load_skill")
    return `skill:${clean(action.name || args.name)}`;
  if (name === "bash") return bashHead(text(args.command));
  if (name === "web_fetch") {
    try {
      return `web_fetch:${clean(new URL(text(args.url)).hostname)}`;
    } catch {
      return "";
    }
  }
  return clean(name);
}
function bashHead(command: string): string {
  const [first = "", second = ""] = command.trim().split(/\s+/u);
  const program = first.replace(/^.*\//u, "").replace(/^['"]|['"]$/gu, "");
  const sub =
    /^(gws|tg|iva|gh|git|npm|bun)$/u.test(program) &&
    /^[a-z][\w-]*$/u.test(second)
      ? ` ${second}`
      : "";
  const head = program + sub;
  return head && !READING_HEADS.has(head) ? `bash:${clean(head)}` : "";
}

function summarize(events: Line[], incoming: Map<string, Line>) {
  const first = events[0];
  const actions = dataFor(events, "eve.actions.requested").flatMap((data) =>
    array(data.actions).map((action, i) =>
      actionHead(action, array(data.args)[i]),
    ),
  );
  const inputs = dataFor(events, "turn.bound").flatMap((data) => {
    const line = incoming.get(text(data.updateKey));
    return line ? [line] : [];
  });
  const steps = new Map(
    dataFor(events, "eve.step.completed")
      .filter(
        (data) =>
          Number.isSafeInteger(data.stepIndex) &&
          number(data.stepIndex) === data.stepIndex,
      )
      .map((data) => [
        data.stepIndex,
        ["in", "out", "cacheRead", "cacheWrite"].reduce(
          (sum, k) => sum + number(record(data.usage)[k]),
          0,
        ),
      ]),
  );
  return {
    ref: turnRef(text(first.session), text(first.turn)),
    session: text(first.session),
    at: at(events.at(-1)!),
    day: text(first.ts).slice(0, 10),
    request: clean(record(inputs.at(-1)?.data).text),
    messages: new Map(inputs.map((line) => [text(line.turn), at(line)])),
    actions,
    steps: steps.size,
    tokens: [...steps.values()].reduce((a, b) => a + b, 0),
    skill:
      actions.some((head) => head.startsWith("skill:")) ||
      dataFor(events, "eve.action.result").some(
        (data) => text(data.name) !== "",
      ),
    stop: events.some(
      (line) =>
        isEvent(line, "stop.requested") || isEvent(line, "eve.turn.cancelled"),
    ),
  };
}
type Turn = ReturnType<typeof summarize>;
function collect(dataDir: string, now: number): Turn[] {
  // Fifteen timezone-named files cover a rolling fourteen-day window.
  const lines = readTrace(dataDir, 15, TRACE_REPEAT_BYTES_PER_FILE)
    .lines.filter(
      (line) =>
        line.source === "telegram" &&
        at(line) >= now - 14 * DAY &&
        at(line) <= now,
    )
    .sort((a, b) => at(a) - at(b));
  const incoming = new Map(
    lines
      .filter(
        (line) =>
          isEvent(line, "inbound.received") &&
          record(line.data).allowlisted === true,
      )
      .map((line) => [text(line.turn), line]),
  );
  const bound = lines.filter(
    (line) =>
      /^[\w-]{1,200}$/u.test(text(line.session)) &&
      /^[\w-]{1,200}$/u.test(text(line.turn)),
  );
  return [
    ...group(bound, (line) =>
      turnRef(text(line.session), text(line.turn)),
    ).values(),
  ].map((events) => summarize(events, incoming));
}

type Group = { heads: string[]; turns: Set<Turn> };
function add(groups: Map<string, Group>, heads: string[], turn: Turn) {
  const key = JSON.stringify(heads),
    found = groups.get(key) ?? { heads, turns: new Set() };
  groups.set(key, found);
  found.turns.add(turn);
}
function render(kind: string, group: Group, count = group.turns.size) {
  const turns = [...group.turns];
  const latest = [...turns].sort(
    (a, b) => b.at - a.at || a.ref.localeCompare(b.ref),
  )[0];
  const steps = turns.map((t) => t.steps).sort((a, b) => a - b);
  const median =
    (steps[Math.floor((steps.length - 1) / 2)] +
      steps[Math.floor(steps.length / 2)]) /
    2;
  const tokens = turns.reduce((sum, t) => sum + t.tokens, 0),
    skill = turns.some((t) => t.skill) ? "yes" : "no";
  return {
    at: latest.at,
    line: insightLine(
      {
        count,
        where: `${kind} ${group.heads.join(" → ")}`.trim(),
        kind: `median steps ${median}, tokens ${tokens}, skill ${skill}`,
        reason: latest.request,
        ref: latest.ref,
        at: latest.at,
      },
      1000,
    ),
  };
}

function patterns(turns: Turn[]) {
  const chains = new Map<string, Group>(),
    long = new Map<string, Group>();
  for (const t of turns) {
    if (t.steps >= 15 && !t.skill)
      add(long, t.actions.filter(Boolean).slice(0, 2), t);
    for (let i = 0; i < t.actions.length; i++)
      for (let n = 3; n <= 6 && i + n <= t.actions.length; n++) {
        const heads = t.actions.slice(i, i + n);
        if (heads.every(Boolean)) add(chains, heads, t);
      }
  }
  return { chains, long };
}
function maximal(chains: Map<string, Group>) {
  const repeats = [...chains.values()].filter(
      (g) =>
        g.turns.size >= 3 && new Set([...g.turns].map((t) => t.day)).size >= 2,
    ),
    hidden = new Set<Group>();
  for (const parent of repeats)
    for (let i = 0; i < parent.heads.length; i++)
      for (
        let n = 3;
        n < parent.heads.length && i + n <= parent.heads.length;
        n++
      ) {
        const child = chains.get(JSON.stringify(parent.heads.slice(i, i + n)));
        if (
          child &&
          child.turns.size === parent.turns.size &&
          [...child.turns].every((t) => parent.turns.has(t))
        )
          hidden.add(child);
      }
  return repeats.filter((g) => !hidden.has(g));
}
export function listTurnRepeats(dataDir: string, nowMs: number): string[] {
  const turns = collect(dataDir, nowMs),
    { chains, long } = patterns(turns);
  const out = maximal(chains).map((g) => render("repeat", g));
  for (const g of long.values()) out.push(render("long without skill", g));
  for (const session of group(turns, (t) => t.session).values()) {
    const times = [
      ...new Map(session.flatMap((t) => [...t.messages])).values(),
    ].sort((a, b) => a - b);
    const inWindow = (t: Turn, start: number) =>
      t.at >= start && t.at <= start + WINDOW;
    const start = times.find(
      (time, i) =>
        i + 3 < times.length &&
        times[i + 3] - time <= WINDOW &&
        session.some((t) => inWindow(t, time) && (t.stop || t.steps >= 10)),
    );
    if (start !== undefined)
      out.push(
        render(
          "guided",
          {
            heads: [],
            turns: new Set(session.filter((t) => inWindow(t, start))),
          },
          times.filter((t) => t >= start && t <= start + WINDOW).length,
        ),
      );
  }
  return out
    .sort((a, b) => b.at - a.at || a.line.localeCompare(b.line))
    .slice(0, 10)
    .map((entry) => entry.line);
}
