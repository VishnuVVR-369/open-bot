"use client";

import type { ModelLogRun } from "@open-bot/api";
import { compactNumber } from "@open-bot/domain";
import { format, isThisYear, isToday } from "date-fns";
import { ChevronRight, ScrollText } from "lucide-react";
import Link from "next/link";
import { BotAvatar as TeammateAvatar } from "@/components/bot-avatar"; // vocabulary: allow
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAppState } from "@/features/app-shell";
import { SettingsNav } from "@/features/settings";
import { formatCost, runInspectorHref } from "../format";
import { useModelLogRuns } from "../hooks";

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

function RunRow({ run }: { run: ModelLogRun }) {
  const { data: state } = useAppState();
  const teammate = state?.bots.find((t) => t.id === run.teammateId); // vocabulary: allow
  const name = run.teammateName ?? "Former teammate";
  const tokens = run.inputTokens + run.outputTokens;
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
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <TeammateAvatar
            name={name}
            color={teammate?.color ?? "#888888"}
            emoji={teammate?.emoji}
            size="sm"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-medium">{name}</span>
            <span className="truncate text-[12.5px] text-muted-foreground">{run.chatTitle}</span>
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

function RunList() {
  const runs = useModelLogRuns();
  if (!runs.data) {
    if (runs.error)
      return (
        <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13.5px]">
          <span className="text-muted-foreground">
            Couldn&apos;t load this. {runs.error.message}
          </span>
          <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
            Try again
          </Button>
        </div>
      );
    return (
      <div className="flex flex-col gap-2" data-testid="model-logs-loading">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  const list = runs.data.pages.flatMap((page) => page.runs);
  if (!list.length)
    return (
      <div
        className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6"
        data-testid="model-logs-empty"
      >
        <ScrollText className="size-5 text-muted-foreground" />
        <p className="text-[14px] font-medium">No model logs yet</p>
        <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
          Each run your teammates do from now on shows up here, with every request it sent the
          model.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
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
  );
}

/** Settings, on its model logs page: recent runs, each opening its inspector. */
export function ModelLogsView() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[176px_minmax(0,1fr)] md:gap-12">
      <SettingsNav current="model-logs" />
      <section className="flex min-w-0 flex-col gap-4" data-testid="settings-model-logs">
        <div className="flex flex-col gap-1">
          <h2 className="text-[16px] font-semibold">Model logs</h2>
          <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
            Every request your teammates sent the model, run by run, with the tools they called and
            how each went. Only you can see them.
          </p>
        </div>
        <RunList />
      </section>
    </div>
  );
}
