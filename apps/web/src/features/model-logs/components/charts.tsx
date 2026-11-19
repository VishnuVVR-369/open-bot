"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Small SVG charts for the Usage tab, drawn by hand: columns (stacked or not) and lines, each with
 * a hover and keyboard readout. Thin marks, 4px rounded column ends, 2px lines, hairline grid,
 * series told apart by `--chart-1..3` with a legend, and text always in text colors.
 */

export interface Series {
  key: string;
  label: string;
  /** A CSS color, one of the chart tokens. */
  color: string;
  values: (number | null)[];
}

const MARGIN = { top: 10, right: 8, bottom: 24, left: 48 };

/** Width of an element, kept current. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry!.contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A rounded top for the axis: 1, 2 or 5 times a power of ten, at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * Five ticks from zero, a round step apart (1, 2, 2.5 or 5 times a power of ten), so no two
 * labels round to the same text. For counts (`whole`), each step is a whole number, so a day with
 * one failed request never puts 0.25 on the axis.
 */
export function axisTicks(max: number, whole = false): number[] {
  const quarter = max > 0 ? max / 4 : 0.25;
  const step = whole ? niceMax(Math.max(1, Math.ceil(quarter))) : niceMax(quarter);
  return [0, step, 2 * step, 3 * step, 4 * step];
}

/** A column with a 4px round at its data end and a square foot on the baseline. */
function columnPath(x: number, top: number, width: number, bottom: number, rounded: boolean) {
  const r = rounded ? Math.min(4, width / 2, bottom - top) : 0;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}

export function Legend({ series, line = false }: { series: Series[]; line?: boolean }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            className={cn("shrink-0", line ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[3px]")}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** The readout beside the pointer: values first, each keyed by a short line of its color. */
function Readout({
  x,
  width,
  title,
  rows,
}: {
  x: number;
  width: number;
  title: string;
  rows: { key: string; color: string; label: string; value: string }[];
}) {
  const box = 176;
  const left = Math.max(0, Math.min(x - box / 2, width - box));
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 flex flex-col gap-1 rounded-lg border bg-popover px-2.5 py-2 text-[12px] shadow-float"
      style={{ left, width: box }}
      role="status"
    >
      <span className="text-muted-foreground">{title}</span>
      {rows.map((row) => (
        <span key={row.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
          <span className="font-semibold text-foreground tabular-nums">{row.value}</span>
          <span className="truncate text-muted-foreground">{row.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Arrow keys move the readout along the chart, as the pointer does. */
function useActive(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive((at) => Math.max(0, Math.min(count - 1, (at ?? (step > 0 ? -1 : count)) + step)));
  };
  return { active, setActive, onKeyDown };
}

function Frame({
  label,
  height,
  children,
}: {
  label: string;
  height: number;
  children: (width: number) => ReactNode;
}) {
  const [ref, width] = useWidth();
  return (
    <div ref={ref} className="relative w-full" style={{ height }} aria-label={label} role="group">
      {width > 0 && children(width)}
    </div>
  );
}

function YAxis({
  ticks,
  y,
  width,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  width: number;
  format: (v: number) => string;
}) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={y(tick)}
            y2={y(tick)}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={MARGIN.left - 8}
            y={y(tick)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted-foreground text-[11px] tabular-nums"
          >
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** The room each axis label gets, so "Sep 14" never touches its neighbor. */
const LABEL_ROOM = 64;

/** Label every `n`th bucket, as many as fit in `width` pixels. */
export function labelStride(count: number, width: number): number {
  const fit = Math.max(2, Math.floor(width / LABEL_ROOM));
  return Math.max(1, Math.ceil(count / fit));
}

/** Columns over buckets, stacked when there is more than one series. */
export function ColumnChart({
  label,
  buckets,
  bucketLabel,
  bucketTitle,
  series,
  format,
  height = 200,
  whole = false,
}: {
  label: string;
  buckets: string[];
  /** A short axis label for a bucket; only as many as fit are shown. */
  bucketLabel: (bucket: string) => string;
  bucketTitle: (bucket: string) => string;
  series: Series[];
  format: (value: number) => string;
  height?: number;
  /** The values are counts, so the axis steps in whole numbers. */
  whole?: boolean;
}) {
  const { active, setActive, onKeyDown } = useActive(buckets.length);
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const ticks = axisTicks(Math.max(0, ...totals), whole);
  const top = ticks[ticks.length - 1]!;
  return (
    <Frame label={label} height={height}>
      {(width) => {
        const plot = {
          w: width - MARGIN.left - MARGIN.right,
          h: height - MARGIN.top - MARGIN.bottom,
        };
        const band = plot.w / Math.max(1, buckets.length);
        const stride = labelStride(buckets.length, plot.w);
        // A 2px gap between columns, less when there are so many that it would hide them.
        const bar = Math.max(1, Math.min(24, band - Math.min(2, band / 3)));
        const y = (v: number) => MARGIN.top + plot.h - (v / top) * plot.h;
        const xOf = (i: number) => MARGIN.left + i * band + (band - bar) / 2;
        return (
          <>
            <svg
              width={width}
              height={height}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onBlur={() => setActive(null)}
              onPointerLeave={() => setActive(null)}
              className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12"
              aria-label={label}
            >
              <YAxis ticks={ticks} y={y} width={width} format={format} />
              {buckets.map((bucket, i) => {
                let base = 0;
                const filled = series.filter((s) => (s.values[i] ?? 0) > 0);
                const tick = i % stride === 0 ? bucketLabel(bucket) : null;
                return (
                  <g key={bucket}>
                    {active === i && (
                      <rect
                        x={MARGIN.left + i * band}
                        y={MARGIN.top}
                        width={band}
                        height={plot.h}
                        className="fill-subtle"
                      />
                    )}
                    {filled.map((s, n) => {
                      const value = s.values[i] ?? 0;
                      const bottom = y(base) - (n > 0 ? 2 : 0);
                      base += value;
                      const segmentTop = y(base);
                      if (bottom - segmentTop < 0.5) return null;
                      return (
                        <path
                          key={s.key}
                          d={columnPath(xOf(i), segmentTop, bar, bottom, n === filled.length - 1)}
                          style={{ fill: s.color }}
                        />
                      );
                    })}
                    {tick && (
                      <text
                        x={MARGIN.left + i * band + band / 2}
                        y={height - 6}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[11px]"
                      >
                        {tick}
                      </text>
                    )}
                    <rect
                      x={MARGIN.left + i * band}
                      y={MARGIN.top}
                      width={band}
                      height={plot.h}
                      fill="transparent"
                      onPointerEnter={() => setActive(i)}
                      onPointerMove={() => setActive(i)}
                    />
                  </g>
                );
              })}
            </svg>
            {active !== null && buckets[active] !== undefined && (
              <Readout
                x={MARGIN.left + active * band + band / 2}
                width={width}
                title={bucketTitle(buckets[active])}
                rows={[...series].reverse().map((s) => ({
                  key: s.key,
                  color: s.color,
                  label: s.label,
                  value: format(s.values[active] ?? 0),
                }))}
              />
            )}
          </>
        );
      }}
    </Frame>
  );
}

/** Lines over time on a 0 to 100 scale, broken where readings are more than `gapMs` apart. */
export function PercentLines({
  label,
  times,
  from,
  to,
  series,
  timeLabel,
  timeTitle,
  gapMs = 6 * 3_600_000,
  height = 180,
}: {
  label: string;
  times: number[];
  from: number;
  to: number;
  series: Series[];
  timeLabel: (ms: number) => string;
  timeTitle: (ms: number) => string;
  gapMs?: number;
  height?: number;
}) {
  const { active, setActive, onKeyDown } = useActive(times.length);
  return (
    <Frame label={label} height={height}>
      {(width) => {
        const plot = {
          w: width - MARGIN.left - MARGIN.right,
          h: height - MARGIN.top - MARGIN.bottom,
        };
        const x = (ms: number) => MARGIN.left + ((ms - from) / Math.max(1, to - from)) * plot.w;
        const y = (v: number) => MARGIN.top + plot.h - (v / 100) * plot.h;
        const ticks = Array.from({ length: 5 }, (_, i) => from + ((to - from) * i) / 4);
        const nearest = (px: number) => {
          let best = 0;
          for (let i = 1; i < times.length; i++)
            if (Math.abs(x(times[i]!) - px) < Math.abs(x(times[best]!) - px)) best = i;
          return best;
        };
        return (
          <>
            <svg
              width={width}
              height={height}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onBlur={() => setActive(null)}
              onPointerLeave={() => setActive(null)}
              onPointerMove={(event) => {
                if (!times.length) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setActive(nearest(event.clientX - rect.left));
              }}
              className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12"
              aria-label={label}
            >
              <YAxis ticks={[0, 25, 50, 75, 100]} y={y} width={width} format={(v) => `${v}%`} />
              {ticks.map((tick, i) => (
                <text
                  key={tick}
                  x={x(tick)}
                  y={height - 6}
                  textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
                  className="fill-muted-foreground text-[11px]"
                >
                  {timeLabel(tick)}
                </text>
              ))}
              {active !== null && times[active] !== undefined && (
                <line
                  x1={x(times[active])}
                  x2={x(times[active])}
                  y1={MARGIN.top}
                  y2={MARGIN.top + plot.h}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                />
              )}
              {series.map((s) => {
                // Runs of readings close enough in time to join.
                const runs: [number, number][][] = [];
                times.forEach((ms, i) => {
                  const value = s.values[i];
                  if (value === null || value === undefined) return;
                  const run = runs.at(-1);
                  const last = run?.at(-1);
                  if (run && last && ms - times[last[0]]! <= gapMs) run.push([i, value]);
                  else runs.push([[i, value]]);
                });
                return (
                  <g key={s.key}>
                    {runs.map((run) =>
                      run.length === 1 ? (
                        <circle
                          key={run[0]![0]}
                          cx={x(times[run[0]![0]]!)}
                          cy={y(run[0]![1])}
                          r={4}
                          style={{ fill: s.color }}
                          stroke="var(--card)"
                          strokeWidth={2}
                        />
                      ) : (
                        <polyline
                          key={run[0]![0]}
                          points={run.map(([i, v]) => `${x(times[i]!)},${y(v)}`).join(" ")}
                          fill="none"
                          style={{ stroke: s.color }}
                          strokeWidth={2}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      ),
                    )}
                    {active !== null &&
                      s.values[active] !== null &&
                      s.values[active] !== undefined && (
                        <circle
                          cx={x(times[active]!)}
                          cy={y(s.values[active]!)}
                          r={4}
                          style={{ fill: s.color }}
                          stroke="var(--card)"
                          strokeWidth={2}
                        />
                      )}
                  </g>
                );
              })}
            </svg>
            {active !== null && times[active] !== undefined && (
              <Readout
                x={x(times[active])}
                width={width}
                title={timeTitle(times[active])}
                rows={series.map((s) => ({
                  key: s.key,
                  color: s.color,
                  label: s.label,
                  value:
                    s.values[active] === null || s.values[active] === undefined
                      ? "-"
                      : `${Math.round(s.values[active]!)}%`,
                }))}
              />
            )}
          </>
        );
      }}
    </Frame>
  );
}
