"use client";

import type { ModelLogUsage } from "@open-bot/api";
import { cacheShare, capMonthLabel, compactNumber, planWindowLabel } from "@open-bot/domain";
import { format } from "date-fns";
import { BarChart3 } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCost } from "../format";
import { useModelLogUsage } from "../hooks";
import { rangeBounds, rangeOf, withRange } from "../ranges";
import { ColumnChart, Legend, PercentLines, type Series } from "./charts";
import { LoadError, RangePicker, useAddress } from "./controls";
import { UsageTable } from "./usage-table";

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` bucket as a date, at noon so no zone moves it to another day. */
const dayDate = (day: string) => new Date(`${day}T12:00:00`);

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-[20px] font-semibold tabular-nums",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </span>
      {note && <span className="text-[12px] text-muted-foreground">{note}</span>}
    </div>
  );
}

function Card({
  title,
  note,
  children,
  testId,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card px-4 py-4"
      data-testid={testId}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {note && <p className="text-[12.5px] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** This month's API key spend against the cap: the fill turns amber near it and red at it. */
function SpendMeter({ apiKey }: { apiKey: ModelLogUsage["apiKey"] }) {
  const share = apiKey.capMicros > 0 ? Math.min(1, apiKey.spendMicros / apiKey.capMicros) : 0;
  const fill = share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-attention" : "bg-foreground/70";
  return (
    <Card
      title="Your API key this month"
      note={`${capMonthLabel(apiKey.monthStart)}, counted from the model logs as the cap is. The cap itself is under Settings, Account.`}
      testId="usage-api-key"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[20px] font-semibold tabular-nums">
          {formatCost(apiKey.spendMicros)}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {apiKey.capMicros > 0
            ? `of a ${formatCost(apiKey.capMicros)} monthly cap`
            : "with no monthly cap"}
        </span>
      </div>
      {apiKey.capMicros > 0 && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="API key spend against the monthly cap"
          aria-valuemin={0}
          aria-valuemax={apiKey.capMicros}
          aria-valuenow={Math.min(apiKey.spendMicros, apiKey.capMicros)}
        >
          <div className={cn("h-full rounded-full", fill)} style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </Card>
  );
}

function Charts({ usage, from, to }: { usage: ModelLogUsage; from: number; to: number }) {
  const buckets = usage.series.map((row) => row.bucket);
  const weekly = usage.bucket === "week";
  const bucketLabel = (bucket: string) => format(dayDate(bucket), "MMM d");
  const bucketTitle = (bucket: string) =>
    weekly ? `Week of ${format(dayDate(bucket), "MMM d")}` : format(dayDate(bucket), "EEE, MMM d");
  const tokens: Series[] = [
    {
      key: "fresh",
      label: "Input, not cached",
      color: "var(--chart-1)",
      values: usage.series.map((row) => Math.max(0, row.inputTokens - row.cachedInputTokens)),
    },
    {
      key: "cached",
      label: "Input, cached",
      color: "var(--chart-2)",
      values: usage.series.map((row) => row.cachedInputTokens),
    },
    {
      key: "output",
      label: "Output",
      color: "var(--chart-3)",
      values: usage.series.map((row) => row.outputTokens),
    },
  ];
  const windows = usage.planWindows;
  const lines: Series[] = [
    {
      key: "primary",
      label: planWindowLabel(windows.primaryMinutes, "primary"),
      color: "var(--chart-1)",
      values: windows.points.map((p) => p.primary),
    },
    {
      key: "secondary",
      label: planWindowLabel(windows.secondaryMinutes, "secondary"),
      color: "var(--chart-3)",
      values: windows.points.map((p) => p.secondary),
    },
  ];
  const per = weekly ? "week" : "day";
  return (
    <>
      <Card
        title="Tokens"
        note={`Each ${per}, in ${usage.timeZone.replace(/_/g, " ")}. Output includes reasoning.`}
        testId="usage-tokens"
      >
        <Legend series={tokens} />
        <ColumnChart
          label={`Tokens per ${per}`}
          buckets={buckets}
          bucketLabel={bucketLabel}
          bucketTitle={bucketTitle}
          series={tokens}
          format={compactNumber}
        />
      </Card>
      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
        <Card
          title="Cost on your API key"
          note={`Each ${per}. Work on your plan costs nothing here.`}
        >
          <ColumnChart
            label={`Cost per ${per}`}
            buckets={buckets}
            bucketLabel={bucketLabel}
            bucketTitle={bucketTitle}
            series={[
              {
                key: "cost",
                label: "Cost",
                color: "var(--chart-1)",
                values: usage.series.map((row) => row.costMicros),
              },
            ]}
            format={(micros) => (micros === 0 ? "$0" : formatCost(micros))}
            height={150}
          />
        </Card>
        <Card
          title="Failed requests"
          note={`Each ${per}: errors, refusals and requests that never finished.`}
        >
          <ColumnChart
            label={`Failed requests per ${per}`}
            buckets={buckets}
            bucketLabel={bucketLabel}
            bucketTitle={bucketTitle}
            series={[
              {
                key: "errors",
                label: "Failed",
                color: "var(--chart-1)",
                values: usage.series.map((row) => row.errors),
              },
            ]}
            format={(n) => n.toLocaleString("en-US")}
            whole
            height={150}
          />
        </Card>
      </div>
      <Card
        title="Your plan's usage windows"
        note={`How much of each window was used, the highest reading each ${windows.step}, from the headers on the plan's responses.`}
        testId="usage-plan-windows"
      >
        {windows.points.length ? (
          <>
            <Legend series={lines} line />
            <PercentLines
              label="Plan usage windows over time"
              times={windows.points.map((p) => new Date(p.at).getTime())}
              from={from}
              to={to}
              series={lines}
              timeLabel={(ms) => format(new Date(ms), "MMM d")}
              timeTitle={(ms) =>
                format(new Date(ms), windows.step === "day" ? "EEE, MMM d" : "EEE, MMM d, h a")
              }
              gapMs={windows.step === "day" ? 36 * 3_600_000 : 6 * 3_600_000}
            />
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No responses from your plan in these dates.
          </p>
        )}
      </Card>
    </>
  );
}

/** Tokens, cost and errors over time, per teammate and model, and the plan's windows. */
export function UsageTab() {
  const { params, set } = useAddress();
  const query = params.toString();
  const range = rangeOf(params, "30d");
  const input = useMemo(() => {
    const bounds = rangeBounds(rangeOf(new URLSearchParams(query), "30d"));
    const to = bounds.to ?? new Date(Math.ceil(Date.now() / DAY_MS) * DAY_MS).toISOString();
    return { from: bounds.from ?? new Date(Date.parse(to) - 30 * DAY_MS).toISOString(), to };
  }, [query]);
  const usage = useModelLogUsage(input);
  const data = usage.data;
  const share = data ? cacheShare(data.totals) : null;
  return (
    <div className="@container flex flex-col gap-4" data-testid="model-logs-usage">
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker
          choice={range}
          allowAny={false}
          onChange={(choice) => set(withRange(params, choice))}
          testId="usage-range"
        />
      </div>
      {!data ? (
        usage.error ? (
          <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
        ) : (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        )
      ) : data.totals.requests === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6">
            <BarChart3 className="size-5 text-muted-foreground" />
            <p className="text-[14px] font-medium">No model requests in these dates</p>
            <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
              Pick a longer range, or come back once your teammates have worked.
            </p>
          </div>
          <SpendMeter apiKey={data.apiKey} />
        </div>
      ) : (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-4 transition-opacity",
            usage.isPlaceholderData && "opacity-60",
          )}
        >
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
            <Tile
              label="Tokens"
              value={compactNumber(data.totals.inputTokens + data.totals.outputTokens)}
              note={`${compactNumber(data.totals.inputTokens)} in · ${compactNumber(data.totals.outputTokens)} out`}
            />
            <Tile
              label="Cached input"
              value={share === null ? "-" : `${Math.round(share * 100)}%`}
              note={`${compactNumber(data.totals.cachedInputTokens)} tokens`}
            />
            <Tile
              label="Cost on your API key"
              value={formatCost(data.totals.costMicros)}
              note={`${data.totals.requests.toLocaleString("en-US")} requests`}
            />
            <Tile
              label="Failed requests"
              value={data.totals.errors.toLocaleString("en-US")}
              tone={data.totals.errors > 0 ? "error" : undefined}
              note={`${((data.totals.errors / data.totals.requests) * 100).toFixed(1)}% of requests`}
            />
          </div>
          <Charts usage={data} from={Date.parse(input.from)} to={Date.parse(input.to)} />
          <SpendMeter apiKey={data.apiKey} />
          <UsageTable
            title="By teammate"
            rows={data.teammates.map((row) => ({
              ...row,
              key: row.teammateId ?? "none",
              name: row.name ?? (row.teammateId ? "Former teammate" : "Outside any run"),
            }))}
          />
          <UsageTable
            title="By model"
            mono
            rows={data.models.map((row) => ({
              ...row,
              key: row.model ?? "none",
              name: row.model ?? "Unknown model",
            }))}
          />
          <UsageTable
            title={data.bucket === "week" ? "By week" : "By day"}
            collapsed
            rows={data.series.map((row) => ({
              ...row,
              key: row.bucket,
              name:
                data.bucket === "week"
                  ? `Week of ${format(dayDate(row.bucket), "MMM d")}`
                  : format(dayDate(row.bucket), "EEE, MMM d"),
            }))}
          />
        </div>
      )}
    </div>
  );
}
