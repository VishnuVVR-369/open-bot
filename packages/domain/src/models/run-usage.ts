import { AUTH_MODES, type AuthMode, type TokenUsage } from "./access";

/**
 * What a run used, as each reply's footer shows it: tokens (input, which includes cached, plus
 * output) and what it cost on the API key. `estimated` when some of it is an estimate: an API key
 * request that ended without reporting its usage (`estimateUsage`).
 */
export interface RunUsage {
  tokens: number;
  costMicros: number;
  estimated: boolean;
}

/** One access mode's legacy totals, copied from `usage_entries` by a migration. */
export interface LegacyModeUsage extends TokenUsage {
  costMicros: number;
}

/**
 * A run's numbers from both producers of usage. `legacy` holds, per access mode, the totals a
 * worker that still wrote `usage_entries` recorded for the run, or null for a mode it had none
 * for. `fromLogs` sums the run's model requests that count toward usage (`counts_usage`, written
 * only by workers that no longer write `usage_entries`), or is null when there are none.
 */
export interface RunUsageSources {
  legacy: Record<AuthMode, LegacyModeUsage | null>;
  fromLogs: RunUsage | null;
}

/**
 * The run's usage: its legacy totals plus its counted model requests. Each request was counted by
 * exactly one of the two producers, so adding them never counts a request twice. Null for a run
 * with neither.
 */
export function runUsage(sources: RunUsageSources): RunUsage | null {
  const parts: RunUsage[] = AUTH_MODES.flatMap((mode) => {
    const legacy = sources.legacy[mode];
    return legacy
      ? [
          {
            tokens: legacy.inputTokens + legacy.outputTokens,
            costMicros: legacy.costMicros,
            estimated: false,
          },
        ]
      : [];
  });
  if (sources.fromLogs) parts.push(sources.fromLogs);
  if (!parts.length) return null;
  return {
    tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
    costMicros: parts.reduce((sum, part) => sum + part.costMicros, 0),
    estimated: parts.some((part) => part.estimated),
  };
}
