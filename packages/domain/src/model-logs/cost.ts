import { costMicros } from "../models";
import type { ResponseUsage } from "./response";
import type { ModelRoute } from "./values";

/**
 * What one request cost, in millionths of a dollar: list prices on the API key, nothing on the
 * plan (a flat subscription), and nothing without usage. An API key request that may have cost
 * money without reporting its usage is priced from an estimate of it instead (`estimateUsage`).
 */
export function requestCostMicros(route: ModelRoute | null, usage: ResponseUsage | null): number {
  if (route !== "api" || !usage) return 0;
  return costMicros(usage);
}

/**
 * How an API key request's usage is estimated when the API never reported it: the stream was cut
 * off before its final event, Codex cancelled it, its body couldn't be read, or the worker stopped
 * while it ran. Every figure errs high, so the cap counts at least what the request cost:
 *
 * - `bytesPerToken`: the input and the output streamed so far, at 2 bytes a token. Text and code
 *   average about 4 bytes a token, and Chinese or Japanese text (3 bytes a character) about 2.5.
 * - `imageTokens`: each image in the input, whatever its size (its base64 bytes are left out).
 * - `outputTokensPerSecond`: from the request's start until it ended, as if the model wrote all
 *   along, faster than the API streams, so reasoning that never streamed is counted too.
 * - `maxInputTokens`: an input whose size can't be known (too large to keep, compressed and
 *   unreadable, or continued from a response the proxy didn't see), larger than any model's window.
 * - `maxOutputTokens`: the most the time-based guess counts.
 *
 * No input is taken to be cached: cached input costs a tenth, so that errs high too.
 */
export const USAGE_ESTIMATE = {
  bytesPerToken: 2,
  imageTokens: 10_000,
  outputTokensPerSecond: 250,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 128_000,
} as const;

/** What a request's input is, for an estimate: its size without images, and how many images. */
export interface InputSize {
  bytes: number;
  images: number;
}

/** What an estimate of a request's usage is made from. */
export interface UsageEstimateBasis {
  /** The input, or null when its size can't be known. */
  input: InputSize | null;
  /** What streamed back before it ended, in bytes. */
  outputBytes: number;
  /** From the request's start until it ended (or until now, for one still running). */
  elapsedMs: number;
}

/** The usage counted for a request that may have cost money but reported none. */
export function estimateUsage(basis: UsageEstimateBasis): ResponseUsage {
  const { bytesPerToken, imageTokens, outputTokensPerSecond, maxInputTokens, maxOutputTokens } =
    USAGE_ESTIMATE;
  const inputTokens = basis.input
    ? Math.min(
        Math.ceil(basis.input.bytes / bytesPerToken) + basis.input.images * imageTokens,
        maxInputTokens,
      )
    : maxInputTokens;
  const outputTokens = Math.max(
    Math.ceil(basis.outputBytes / bytesPerToken),
    Math.min(
      Math.ceil((Math.max(basis.elapsedMs, 0) / 1000) * outputTokensPerSecond),
      maxOutputTokens,
    ),
  );
  return { inputTokens, cachedInputTokens: 0, outputTokens, reasoningTokens: 0 };
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A request body's input size, for an estimate. Images count as images, not as their base64
 * bytes: an inline image (`data:image/...`) and an image item that names one elsewhere. Null when
 * the request continues a response the proxy didn't see (`previous_response_id` with an input it
 * couldn't rebuild), since the API reads that response's whole context too.
 */
export function inputSizeOf(body: unknown, inputRebuilt: boolean): InputSize | null {
  if (isRecord(body) && typeof body.previous_response_id === "string" && body.previous_response_id)
    if (!inputRebuilt) return null;
  let images = 0;
  const json = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      images += 1;
      return "";
    }
    if (
      isRecord(value) &&
      value.type === "input_image" &&
      !(typeof value.image_url === "string" && value.image_url.startsWith("data:image/"))
    )
      images += 1;
    return value;
  });
  return { bytes: json === undefined ? 0 : encoder.encode(json).length, images };
}

/**
 * How much of a response streamed back, in bytes: its text, its output items, or the pieces it
 * streamed before they were done, whichever is largest.
 */
export function outputBytesOf(
  response: { text: string; output: unknown[]; deltaBytes: number } | null,
): number {
  if (!response) return 0;
  const text = encoder.encode(response.text).length;
  const items = response.output.length ? encoder.encode(JSON.stringify(response.output)).length : 0;
  return Math.max(text, items, response.deltaBytes);
}
