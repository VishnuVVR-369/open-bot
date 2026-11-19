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

/**
 * Why the API key fallback is off although a key may be saved, so its spend can't run past the
 * monthly cap unseen:
 * - `logging_off`: model logging is off (`MODEL_PROXY=off`), and the cap counts the key's spend
 *   from the model logs.
 * - `logs_unsaved`: the model logs of API key requests can't be saved right now, so their spend
 *   isn't in the database the cap reads; it is back on once they are saved.
 */
export const FALLBACK_OFF_REASONS = ["logging_off", "logs_unsaved"] as const;
export type FallbackOffReason = (typeof FALLBACK_OFF_REASONS)[number];

/**
 * Why a run can't reach the model: the plan is limited and there is no API key, the key reached
 * this month's cap, or the key's fallback is off (`FallbackOffReason`).
 */
export const BLOCKED_REASONS = ["no_key", "cap_reached", ...FALLBACK_OFF_REASONS] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export type AuthDecision = { mode: AuthMode } | { mode: "blocked"; reason: BlockedReason };

/** Which way a run reaches the model: the plan, the API key while the plan is limited, or not at all. */
export function decideAuthMode(input: {
  now: Date;
  planLimitedUntil: Date | null;
  hasApiKey: boolean;
  /** Why the key's spend can't be counted toward the cap right now, or null when it can. */
  fallbackOff: FallbackOffReason | null;
  spendMicros: number;
  capMicros: number;
}): AuthDecision {
  if (!input.planLimitedUntil || input.planLimitedUntil <= input.now) return { mode: "plan" };
  // Before the key: adding one wouldn't help while its spend can't be counted.
  if (input.fallbackOff) return { mode: "blocked", reason: input.fallbackOff };
  if (!input.hasApiKey) return { mode: "blocked", reason: "no_key" };
  if (input.spendMicros >= input.capMicros) return { mode: "blocked", reason: "cap_reached" };
  return { mode: "api_key" };
}

export function formatDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 2 : 0)}`;
}
