export const CONTEXT_WINDOW_CONFIGURATION_ERROR =
  "CONTEXT_WINDOW_CONFIGURATION_ERROR";

export class ContextWindowConfigurationError extends Error {
  declare readonly code: typeof CONTEXT_WINDOW_CONFIGURATION_ERROR;
  declare readonly variable: string;
  declare readonly value: string;

  constructor(variable: string, value: string) {
    super(
      `Invalid ${variable} ${JSON.stringify(value)}; expected a positive safe integer — run: iva config`,
    );
    this.name = "ContextWindowConfigurationError";
    this.code = CONTEXT_WINDOW_CONFIGURATION_ERROR;
    this.variable = variable;
    this.value = value;
  }
}

export function resolveContextWindow(
  variable: string,
  raw: string,
  fallback?: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback?: number,
): number {
  if (raw !== undefined && !/^\d+$/.test(raw))
    throw new ContextWindowConfigurationError(variable, raw);
  const value = raw === undefined ? fallback : Number(raw);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ContextWindowConfigurationError(
      variable,
      raw ?? String(fallback),
    );
  return value;
}

/** Known conservative windows already used by the shipped provider/model routes. */
const HELPER_WINDOWS: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  claude: {
    ...Object.fromEntries(
      [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-opus-4-8",
      ].map((model) => [model, 1_000_000]),
    ),
    "claude-haiku-4-5-20251001": 200_000,
  },
  ollama: { "deepseek-v4-pro": 131072 },
  opencode: { "deepseek-v4-pro": 131072 },
  codex: { "gpt-5.5": 272000 },
  openrouter: { "openai/gpt-5.1": 131072 },
};
export function helperModelWindow(
  provider: string,
  model: string,
  chatModel: string,
  chatWindow: number | null,
): number | null {
  if (model === chatModel && chatWindow !== null) return chatWindow;
  const route = provider === "claude" ? model.replace(/\[1m\]$/, "") : model;
  const window = HELPER_WINDOWS[provider]?.[route];
  return typeof window === "number" ? window : null;
}
