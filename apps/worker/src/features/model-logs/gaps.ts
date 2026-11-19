// What the model log writer keeps of records it lost, until it saves them as `model_log_gaps`
// rows: how many of each kind, what the API key requests among them cost, and when. Each gap holds
// the records of one calendar month (UTC), so the API key spend it keeps counts in the month its
// requests started, however the records around it were captured.
import type { modelLogGaps } from "@open-bot/db";
import { type ModelRoute, monthStart } from "@open-bot/domain";

/** How many of each kind of record were lost, and what the API key requests among them cost. */
export interface LostCounts {
  requests: number;
  codexEvents: number;
  runTurns: number;
  apiRequests: number;
  /** What the API key requests cost, in millionths of a dollar, estimated for some. */
  apiCostMicros: number;
  /** API key requests whose cost is an estimate. */
  apiRequestsEstimated: number;
}

export const NONE_LOST: LostCounts = {
  requests: 0,
  codexEvents: 0,
  runTurns: 0,
  apiRequests: 0,
  apiCostMicros: 0,
  apiRequestsEstimated: 0,
};

/** What a lost request adds to a gap. */
export function lostRequest(
  route: ModelRoute | null,
  costMicros: number,
  estimated: boolean,
): LostCounts {
  const api = route === "api";
  return {
    ...NONE_LOST,
    requests: 1,
    apiRequests: api ? 1 : 0,
    apiCostMicros: api ? costMicros : 0,
    apiRequestsEstimated: api && estimated ? 1 : 0,
  };
}

export function addCounts(a: LostCounts, b: LostCounts): LostCounts {
  return {
    requests: a.requests + b.requests,
    codexEvents: a.codexEvents + b.codexEvents,
    runTurns: a.runTurns + b.runTurns,
    apiRequests: a.apiRequests + b.apiRequests,
    apiCostMicros: a.apiCostMicros + b.apiCostMicros,
    apiRequestsEstimated: a.apiRequestsEstimated + b.apiRequestsEstimated,
  };
}

/** The start of the calendar month (UTC) of a time in milliseconds. */
export function monthOf(at: number): number {
  return monthStart(new Date(at)).getTime();
}

/** One lost record: when it was captured, and what it adds to its gap. */
export interface LostRecord {
  at: number;
  counts: LostCounts;
}

/**
 * Records of one calendar month (UTC) that were lost, waiting to be recorded as one
 * `model_log_gaps` row.
 */
export interface PendingGap extends LostCounts {
  month: number;
  firstAt: Date;
  lastAt: Date;
  reason: string;
}

/** A pending gap as its row. */
export function gapRow({ month: _month, ...gap }: PendingGap): typeof modelLogGaps.$inferInsert {
  return gap;
}

/** How many records a gap lost. */
export function lostTotal(gap: LostCounts): number {
  return gap.requests + gap.codexEvents + gap.runTurns;
}

/** Two sets of lost requests of the same month as one. */
export function mergeGaps(gap: PendingGap | undefined, more: PendingGap): PendingGap {
  if (!gap) return more;
  return {
    month: gap.month,
    firstAt: gap.firstAt < more.firstAt ? gap.firstAt : more.firstAt,
    lastAt: gap.lastAt > more.lastAt ? gap.lastAt : more.lastAt,
    ...addCounts(gap, more),
    // Each distinct reason once, so a long outage doesn't grow it without end.
    reason:
      gap.reason.includes(more.reason) || gap.reason.length > 2_000
        ? gap.reason
        : `${gap.reason}; ${more.reason}`,
  };
}
