// One classifier and one human text for calls, schedule stderr, doctor and Notices.
export const MODEL_AUTH_REPEAT_MS = 24 * 60 * 60 * 1000;
export type AuthLanguage = "ru" | "en";
const PROVIDERS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "ChatGPT",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  ollama: "Ollama",
  custom: "API",
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function errorEvidence(error: unknown): string {
  const obj = record(error);
  const details = record(obj.details);
  const fields = [
    "name",
    "message",
    "code",
    "statusCode",
    "upstreamStatusCode",
    "upstreamMessage",
    "apiErrorMessage",
    "tail",
  ];
  return [
    typeof error === "string" ? error : "",
    ...fields.flatMap((key) => [obj[key], details[key]]),
  ]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join("\n");
}

/** Read only error evidence, never stacks, tool results or request bodies. */
export function modelAuthFailure(
  error: unknown,
  provider?: string,
): string | null {
  const evidence = errorEvidence(error);
  if (/\b(?:429|408|402|5\d\d|5xx)\b/iu.test(evidence)) return null;
  const auth =
    /failed to authenticate|oauth session expired|not signed in|\/login\b|invalid[ _-]?(?:x[ _-]?)?api[ _-]?key|CODEX_AUTH_EXPIRED|token refresh failed:\s*(?:400|401)|invalid_grant|not logged in|unauthorized|authentication|invalid token/iu.test(
      evidence,
    );
  const forbiddenKey =
    /\b403\b/u.test(evidence) &&
    /\b(?:key|token|authorization|authentication)\b/iu.test(evidence);
  if (!auth && !forbiddenKey && !/\b401\b/u.test(evidence)) return null;
  return authProvider(evidence, provider);
}
function authProvider(
  evidence: string,
  provider = process.env.MODEL_PROVIDER ?? "custom",
): string {
  if (/CODEX_AUTH_EXPIRED|token refresh failed|invalid_grant/iu.test(evidence))
    return "codex";
  if (/ClaudeCliError|oauth session expired|claude auth login/iu.test(evidence))
    return "claude";
  return Object.hasOwn(PROVIDERS, provider) ? provider : "custom";
}

const JOB_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  "memory-night": ["ночная память", "nightly memory"],
  proactive: ["обзор дня", "daily overview"],
  "memory-digest": ["обзор дня", "daily overview"],
};
function authJobName(name: string, lang: AuthLanguage): string {
  return (
    JOB_NAMES[name]?.[lang === "ru" ? 0 : 1] ??
    (lang === "ru" ? "задание по расписанию" : "scheduled job")
  );
}

type AuthTextFacts = {
  since?: number;
  answers?: boolean;
  jobs?: readonly string[];
  timeZone?: string;
};
function authEffects(facts: AuthTextFacts, lang: AuthLanguage): string[] {
  const jobs = [
    ...new Set((facts.jobs ?? []).map((job) => authJobName(job, lang))),
  ];
  return [
    ...(facts.answers
      ? [lang === "ru" ? "ответы на сообщения" : "replies to messages"]
      : []),
    ...jobs,
  ];
}
function authSince(facts: AuthTextFacts, lang: AuthLanguage): string {
  if (facts.since === undefined) return "";
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", {
    timeZone: facts.timeZone ?? "UTC",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(facts.since);
}
function authRepair(provider: string): string | null {
  if (provider === "claude") return "claude auth login";
  return provider === "codex" ? "iva login" : null;
}
export function modelAuthText(
  provider: string,
  lang: AuthLanguage,
  facts: AuthTextFacts = {},
): string {
  const name = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : "API";
  const effects = authEffects(facts, lang);
  const when = authSince(facts, lang);
  const repair = authRepair(provider);
  if (lang === "ru")
    return `Вход Ивы в ${name} истёк${effects.length ? `, поэтому сейчас недоступны ${effects.join(", ")}` : ""}${when ? ` (с ${when})` : ""}.\nКак починить: на машине, где стоит Ива, ${repair ? `выполните \`${repair}\`` : "замените ключ в /menu → Модель"}, затем напишите мне любое сообщение.`;
  return `Iva's login to ${name} has expired${effects.length ? `, so these are currently unavailable: ${effects.join(", ")}` : ""}${when ? ` (since ${when})` : ""}.\nHow to fix: on the machine running Iva, ${repair ? `run \`${repair}\`` : "replace the key in /menu → Model"}, then send me any message.`;
}

export function modelAuthRecoveryText(
  provider: string,
  lang: AuthLanguage,
  jobs: readonly string[],
): string {
  const name = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : "API";
  const base =
    lang === "ru"
      ? `Вход в ${name} восстановлен, я снова на связи.`
      : `Login to ${name} is restored, I am available again.`;
  const night = jobs.includes("memory-night")
    ? lang === "ru"
      ? " Ночная память соберёт пропущенные дни при следующем запуске."
      : " Nightly memory will catch up on missed days at its next run."
    : "";
  const rest = jobs.filter((job) => job !== "memory-night");
  // Names come from jobs.json, but only safe schedule names become command arguments.
  const commands = rest
    .filter((job) => /^[a-zA-Z0-9_-]+$/u.test(job))
    .map((job) => `\`iva jobs ack ${job}\``)
    .join(", ");
  const ack = commands
    ? lang === "ru"
      ? ` Проверьте оставшиеся провалы и закройте их: ${commands}.`
      : ` Check the remaining failures and acknowledge them: ${commands}.`
    : "";
  return base + night + ack;
}

/** A direct SDK caller reports its successful call in the existing schedule stderr tail. */
export function modelAuthSuccessLine(provider: string, at: number): string {
  return `iva-model-auth-success ${provider} ${at}`;
}
export function modelAuthSuccess(
  tail: string,
): { provider: string; at: number } | null {
  const match =
    /^iva-model-auth-success (claude|codex|openrouter|opencode|ollama|custom) (\d+)$/mu.exec(
      tail,
    );
  if (!match) return null;
  const at = Number(match[2]);
  return Number.isSafeInteger(at) && at > 0 ? { provider: match[1], at } : null;
}
