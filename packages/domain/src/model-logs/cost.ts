import { costMicros } from "../models";
import type { ResponseUsage } from "./response";
import type { ModelRoute } from "./values";

/**
 * What one request cost, in millionths of a dollar: list prices on the API key, nothing on the
 * plan (a flat subscription), and nothing when the response reported no usage.
 */
export function requestCostMicros(route: ModelRoute | null, usage: ResponseUsage | null): number {
  if (route !== "api" || !usage) return 0;
  return costMicros(usage);
}
