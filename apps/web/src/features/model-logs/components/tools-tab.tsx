"use client";

import type { ToolFailure, ToolStat } from "@open-bot/api";
import { format } from "date-fns";
import { CircleHelp, Hourglass, Link2, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatMs, runInspectorHref } from "../format";
import { useModelLogFilterOptions, useToolFailures, useToolStats } from "../hooks";
import { rangeBounds, rangeOf, withRange } from "../ranges";
import { FilterSelect, LoadError, RangePicker, useAddress } from "./controls";
import { ClampedText } from "./text-block";

const percent = (part: number, whole: number) =>
  whole === 0 ? "0%" : `${Math.round((part / whole) * 1000) / 10}%`;

/** The stats grid, shared by its header and rows; narrow lists keep the name and the failures. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_56px_88px] items-center gap-3 @xl:grid-cols-[minmax(0,1fr)_64px_104px_72px_72px_80px]";

function StatRow({
  stat,
  selected,
  onSelect,
}: {
  stat: ToolStat;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        disabled={stat.failed === 0 && !selected}
        className={cn(
          "w-full px-4 py-2.5 text-left text-[13px] tabular-nums transition-colors enabled:hover:bg-subtle/60",
          COLUMNS,
          selected && "bg-subtle",
        )}
        title={stat.failed > 0 ? "Show only this tool's failures" : undefined}
        data-testid="tool-stat"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-[13px]">{stat.name}</span>
          {stat.unknown > 0 && (
            <span className="text-[12px] text-muted-foreground">
              {stat.unknown === 1 ? "1 outcome" : `${stat.unknown} outcomes`} too large to keep
            </span>
          )}
        </span>
        <span className="text-right">{stat.calls.toLocaleString("en-US")}</span>
        <span
          className={cn(
            "text-right",
            stat.failed > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {stat.failed > 0 ? `${stat.failed} · ${percent(stat.failed, stat.calls)}` : "0"}
        </span>
        <span className="hidden text-right text-muted-foreground @xl:block">
          {formatMs(stat.medianMs)}
        </span>
        <span className="hidden text-right text-muted-foreground @xl:block">
          {formatMs(stat.p95Ms)}
        </span>
        <span className="hidden text-right text-muted-foreground @xl:block">{stat.teammates}</span>
      </button>
    </li>
  );
}

/** How surely a failure is tied to the model's call, in plain words. */
function Certainty({ failure }: { failure: ToolFailure }) {
  const call = failure.callName ? (
    <code className="font-mono text-[12px] text-foreground">{failure.callName}</code>
  ) : null;
  const [Icon, text] =
    failure.link === "exact"
      ? [Link2, <>Called by the model as {call}</>]
      : failure.link === "only_candidate"
        ? [Link2, <>Likely made by the model&apos;s code cell {call}, the only one running then</>]
        : failure.link === "ambiguous"
          ? [
              CircleHelp,
              <>
                Uncertain: {failure.candidates} code cells were running then, {call} is one of them
              </>,
            ]
          : [CircleHelp, <>Not tied to any logged model call</>];
  return (
    <p
      className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground"
      data-testid="failure-certainty"
      data-link={failure.link}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

function FailureCard({ failure }: { failure: ToolFailure }) {
  const badge = [
    failure.status ? failure.status[0]!.toUpperCase() + failure.status.slice(1) : "Failed",
    failure.exitCode !== null ? `exit ${failure.exitCode}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [
    format(new Date(failure.at), "MMM d, h:mm:ss a"),
    failure.durationMs !== null ? formatMs(failure.durationMs) : null,
    [failure.teammateName ?? "Former teammate", failure.chatTitle].filter(Boolean).join(" in "),
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <li
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-destructive/25 bg-card px-4 py-3"
      data-testid="tool-failure"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-[13.5px] font-medium">
            {failure.name}
          </span>
          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-px text-[11.5px] font-medium text-destructive">
            {badge}
          </span>
          <Link
            href={runInspectorHref(failure.runId)}
            className="ml-auto shrink-0 text-[12.5px] font-medium underline-offset-4 hover:underline"
            data-testid="failure-run-link"
          >
            Open run
          </Link>
        </div>
        <p className="flex flex-wrap gap-x-1.5 text-[12.5px] text-muted-foreground tabular-nums">
          {facts.map((fact, i) => (
            <span key={`${i}-${fact}`} className="min-w-0 [overflow-wrap:anywhere]">
              {fact}
              {i < facts.length - 1 && " ·"}
            </span>
          ))}
        </p>
        <Certainty failure={failure} />
      </div>
      {failure.error && <ClampedText text={failure.error} mono className="text-destructive" />}
      {failure.bodiesExpiredAt ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Hourglass className="size-3.5" />
          Its input and output expired on {format(new Date(failure.bodiesExpiredAt), "MMM d, yyyy")}
          .
        </p>
      ) : (
        <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">Input</span>
            {failure.input ? (
              <ClampedText text={failure.input.text} chars={failure.input.chars} mono />
            ) : (
              <p className="text-[13px] text-muted-foreground italic">None recorded</p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">Output</span>
            {failure.output ? (
              <ClampedText text={failure.output.text} chars={failure.output.chars} mono />
            ) : (
              <p className="text-[13px] text-muted-foreground italic">None recorded</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Failures({
  input,
}: {
  input: { from?: string; to?: string; teammateId?: string; tool?: string };
}) {
  const failures = useToolFailures(input);
  const list = failures.data?.pages.flatMap((page) => page.failures);
  if (!list) {
    if (failures.error)
      return <LoadError error={failures.error} onRetry={() => void failures.refetch()} />;
    return <Skeleton className="h-32 w-full rounded-xl" />;
  }
  if (!list.length)
    return (
      <p className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
        No tool call failed in these dates.
      </p>
    );
  return (
    <div className={cn("flex flex-col gap-3", failures.isPlaceholderData && "opacity-60")}>
      <ul className="@container flex flex-col gap-2" data-testid="tool-failures">
        {list.map((failure) => (
          <FailureCard key={failure.eventId} failure={failure} />
        ))}
      </ul>
      {failures.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={failures.isFetchingNextPage}
          onClick={() => void failures.fetchNextPage()}
        >
          {failures.isFetchingNextPage ? "Loading…" : "Show older failures"}
        </Button>
      )}
    </div>
  );
}

/** Every tool across teammates: how often it ran and failed, how long it took, and each failure. */
export function ToolsTab() {
  const { params, set, setParam } = useAddress();
  const options = useModelLogFilterOptions();
  const query = params.toString();
  const range = rangeOf(params, "30d");
  const input = useMemo(() => {
    const address = new URLSearchParams(query);
    const teammateId = address.get("teammate") ?? undefined;
    return { ...rangeBounds(rangeOf(address, "30d")), ...(teammateId ? { teammateId } : {}) };
  }, [query]);
  const tool = params.get("tool") ?? undefined;
  const stats = useToolStats(input);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker
          choice={range}
          allowAny={false}
          onChange={(choice) => set(withRange(params, choice))}
          testId="tools-range"
        />
        <FilterSelect
          label="Teammate"
          allLabel="All teammates"
          value={params.get("teammate") ?? undefined}
          options={(options.data?.teammates ?? []).map((t) => ({ value: t.id, label: t.name }))}
          onChange={(value) => setParam("teammate", value)}
        />
      </div>
      {!stats.data ? (
        stats.error ? (
          <LoadError error={stats.error} onRetry={() => void stats.refetch()} />
        ) : (
          <Skeleton className="h-48 w-full rounded-xl" />
        )
      ) : !stats.data.length ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6">
          <Wrench className="size-5 text-muted-foreground" />
          <p className="text-[14px] font-medium">No tool calls in these dates</p>
          <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
            Shell commands, file edits, open-bot and MCP tools your teammates use show up here.
          </p>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "@container overflow-hidden rounded-xl border bg-card",
              stats.isPlaceholderData && "opacity-60",
            )}
          >
            <div
              className={cn(
                "border-b bg-subtle/60 px-4 py-2 text-[12px] font-medium text-muted-foreground",
                COLUMNS,
              )}
              aria-hidden
            >
              <span>Tool</span>
              <span className="text-right">Calls</span>
              <span className="text-right">Failed</span>
              <span className="hidden text-right @xl:block">Median</span>
              <span className="hidden text-right @xl:block">Slowest 5%</span>
              <span className="hidden text-right @xl:block">Teammates</span>
            </div>
            <ul className="divide-y" data-testid="tool-stats">
              {stats.data.map((stat) => (
                <StatRow
                  key={`${stat.type}-${stat.name}`}
                  stat={stat}
                  selected={tool === stat.name}
                  onSelect={() => setParam("tool", tool === stat.name ? null : stat.name)}
                />
              ))}
            </ul>
          </div>
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold">Failures</h3>
              {tool && (
                <button
                  type="button"
                  onClick={() => setParam("tool", null)}
                  className="flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 font-mono text-[12px] hover:bg-muted"
                  aria-label={`Show every tool's failures, not only ${tool}'s`}
                >
                  {tool}
                  <X className="size-3" />
                </button>
              )}
            </div>
            <p className="max-w-[70ch] text-[13px] text-muted-foreground">
              Newest first. A tool the model called directly is tied to that call exactly. A tool a
              code cell ran is tied by time, so each says how sure that is.
            </p>
            <Failures input={{ ...input, ...(tool ? { tool } : {}) }} />
          </section>
        </>
      )}
    </div>
  );
}
