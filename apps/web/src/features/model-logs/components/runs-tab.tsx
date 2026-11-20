"use client";

import type { ModelLogRun } from "@open-bot/api";
import { compactNumber, snippetParts } from "@open-bot/domain";
import { format, isThisYear, isToday } from "date-fns";
import { ChevronRight, Hourglass, KeyRound, ScrollText, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAppState } from "@/features/app-shell";
import { formatCost, runInspectorHref } from "../format";
import { useModelLogRuns } from "../hooks";
import { runFiltersOf } from "../ranges";
import { LoadError, useAddress } from "./controls";
import { RunFilters } from "./run-filters";

function when(iso: string): string {
  const date = new Date(iso);
  if (isToday(date)) return format(date, "h:mm a");
  return format(date, isThisYear(date) ? "MMM d, h:mm a" : "MMM d, yyyy");
}

/**
 * The grid both the header and each row lay out on, once the list itself is wide enough for the
 * names to keep room beside the numbers; narrower, each row stacks its numbers under the names.
 */
const COLUMNS =
  "@2xl:grid @2xl:grid-cols-[minmax(0,1fr)_128px_72px_72px_72px_52px_16px] @2xl:items-center @2xl:gap-4";

/** A row's numbers on a phone, each kept whole when the line wraps. */
function phoneStats(run: ModelLogRun): { text: string; error?: boolean }[] {
  const parts: { text: string; error?: boolean }[] = [
    { text: when(run.createdAt) },
    { text: run.requests === 1 ? "1 request" : `${run.requests} requests` },
    { text: `${compactNumber(run.inputTokens + run.outputTokens)} tokens` },
  ];
  if (run.costMicros > 0) parts.push({ text: formatCost(run.costMicros) });
  if (run.errors > 0)
    parts.push({ text: run.errors === 1 ? "1 error" : `${run.errors} errors`, error: true });
  return parts;
}

/** Where the search matched, its words marked. */
function Match({ snippet }: { snippet: string }) {
  return (
    <span
      className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]"
      data-testid="model-log-match"
    >
      {snippetParts(snippet).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[3px] bg-muted px-0.5 font-medium text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function RunRow({ run }: { run: ModelLogRun }) {
  const { data: state } = useAppState();
  const teammate = state?.teammates.find((t) => t.id === run.teammateId);
  const name = run.teammateName ?? "Former teammate";
  const tokens = run.inputTokens + run.outputTokens;
  const onKey = run.accessModes.includes("api_key");
  return (
    <li>
      <Link
        href={runInspectorHref(run.runId)}
        className={cn(
          "flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-subtle/60",
          COLUMNS,
        )}
        data-testid="model-log-run"
      >
        <span className="flex min-w-0 flex-1 items-start gap-3">
          <TeammateAvatar
            name={name}
            color={teammate?.color ?? "#888888"}
            emoji={teammate?.emoji}
            size="sm"
          />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[14px] font-medium">{name}</span>
              {onKey && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-subtle px-1.5 py-px text-[11.5px] text-muted-foreground"
                  title="Some or all of this run used your API key"
                >
                  <KeyRound className="size-3" />
                  API key
                </span>
              )}
              {run.bodiesExpiredAt && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-subtle px-1.5 py-px text-[11.5px] text-muted-foreground"
                  title={`Bodies expired on ${format(new Date(run.bodiesExpiredAt), "MMM d, yyyy")}`}
                  data-testid="run-expired"
                >
                  <Hourglass className="size-3" />
                  Expired
                </span>
              )}
            </span>
            <span className="truncate text-[12.5px] text-muted-foreground">{run.chatTitle}</span>
            {run.match && <Match snippet={run.match} />}
            {/* On a phone the numbers go under the names. */}
            <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-[12.5px] text-muted-foreground tabular-nums @2xl:hidden">
              {phoneStats(run).map((part, i, parts) => (
                <span key={part.text} className="whitespace-nowrap">
                  <span className={part.error ? "text-destructive" : undefined}>{part.text}</span>
                  {i < parts.length - 1 && " ·"}
                </span>
              ))}
            </span>
          </span>
        </span>
        <span className="hidden text-[13px] whitespace-nowrap text-muted-foreground tabular-nums @2xl:block">
          {when(run.createdAt)}
        </span>
        <span className="hidden text-right text-[13px] tabular-nums @2xl:block">
          {run.requests}
        </span>
        <span className="hidden text-right text-[13px] tabular-nums @2xl:block">
          {compactNumber(tokens)}
        </span>
        <span className="hidden text-right text-[13px] tabular-nums @2xl:block">
          {run.costMicros > 0 ? formatCost(run.costMicros) : "-"}
        </span>
        <span
          className={cn(
            "hidden text-right text-[13px] tabular-nums @2xl:block",
            run.errors > 0 ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {run.errors}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function Empty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  if (filtered)
    return (
      <div
        className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6"
        data-testid="model-logs-no-match"
      >
        <SearchX className="size-5 text-muted-foreground" />
        <p className="text-[14px] font-medium">No runs match</p>
        <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
          Try other words or fewer filters. Search looks through what was sent and what came back,
          but not through bodies that have expired.
        </p>
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    );
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6"
      data-testid="model-logs-empty"
    >
      <ScrollText className="size-5 text-muted-foreground" />
      <p className="text-[14px] font-medium">No model logs yet</p>
      <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
        Each run your teammates do from now on shows up here, with every request it sent the model.
      </p>
    </div>
  );
}

/** Runs with model logs, newest first, narrowed by the filters in the address. */
export function RunsTab() {
  const { params, set } = useAddress();
  const query = params.toString();
  const filters = useMemo(() => runFiltersOf(new URLSearchParams(query)), [query]);
  const filtered = Object.keys(filters).length > 0;
  const runs = useModelLogRuns(filters);
  const list = runs.data?.pages.flatMap((page) => page.runs);
  return (
    <div className="flex flex-col gap-4">
      <RunFilters />
      {!list ? (
        runs.error ? (
          <LoadError error={runs.error} onRetry={() => void runs.refetch()} />
        ) : (
          <div className="flex flex-col gap-2" data-testid="model-logs-loading">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        )
      ) : !list.length ? (
        <Empty filtered={filtered} onClear={() => set(new URLSearchParams())} />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3 transition-opacity",
            runs.isPlaceholderData && "opacity-60",
          )}
        >
          <div className="@container overflow-hidden rounded-xl border bg-card">
            <div
              className={cn(
                "hidden border-b bg-subtle/60 px-4 py-2 text-[12px] font-medium text-muted-foreground",
                COLUMNS,
              )}
              aria-hidden
            >
              <span>Run</span>
              <span>Started</span>
              <span className="text-right">Requests</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Errors</span>
              <span />
            </div>
            <ul className="divide-y" data-testid="model-log-runs">
              {list.map((run) => (
                <RunRow key={run.runId} run={run} />
              ))}
            </ul>
          </div>
          {runs.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              {runs.isFetchingNextPage ? "Loading…" : "Show older runs"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
