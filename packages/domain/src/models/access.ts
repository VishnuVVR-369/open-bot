import { z } from "zod";

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

/** How a run reaches the model: your ChatGPT plan, or the OpenAI API key you added. */
export const AUTH_MODES = ["plan", "api_key"] as const;
export const authModeSchema = z.enum(AUTH_MODES);
export type AuthMode = (typeof AUTH_MODES)[number];

/** How Codex signs in to ChatGPT: a device-code login kept in the computer, or this Mac's (development). */
export const CHATGPT_AUTH_SOURCES = ["device", "host"] as const;
export const chatgptAuthSourceSchema = z.enum(CHATGPT_AUTH_SOURCES);
export type ChatgptAuthSource = (typeof CHATGPT_AUTH_SOURCES)[number];

export type AuthDecision =
  { mode: AuthMode } | { mode: "blocked"; reason: "no_key" | "cap_reached" };

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
