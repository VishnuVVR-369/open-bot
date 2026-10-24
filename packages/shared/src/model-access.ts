/** List prices of the model on the API, in dollars per million tokens. */
export const API_PRICES = { input: 2, cachedInput: 0.1, output: 10 } as const;

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * What a run costs on the API key, in millionths of a dollar.
 * Input tokens include the cached ones, which are billed at the cached price.
 * ($1 per million tokens is exactly one millionth of a dollar per token.)
 */
export function costMicros(usage: TokenUsage): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return Math.round(
    (usage.inputTokens - cached) * API_PRICES.input +
      cached * API_PRICES.cachedInput +
      usage.outputTokens * API_PRICES.output,
  );
}

export type AuthDecision =
  { mode: "plan" } | { mode: "api_key" } | { mode: "blocked"; reason: "no_key" | "cap_reached" };

/** Which way a run reaches the model: the plan, the API key while the plan is limited, or not at all. */
export function decideAuthMode(input: {
  now: Date;
  planLimitedUntil: Date | null;
  hasApiKey: boolean;
  spendMicros: number;
  capMicros: number;
}): AuthDecision {
  if (!input.planLimitedUntil || input.planLimitedUntil <= input.now) return { mode: "plan" };
  if (!input.hasApiKey) return { mode: "blocked", reason: "no_key" };
  if (input.spendMicros >= input.capMicros) return { mode: "blocked", reason: "cap_reached" };
  return { mode: "api_key" };
}

export function formatDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 2 : 0)}`;
}
