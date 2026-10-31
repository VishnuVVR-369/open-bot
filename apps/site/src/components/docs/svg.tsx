import { useId, type ReactNode } from "react";

/**
 * Small building blocks for architecture and state diagrams, drawn as SVG.
 * Diagrams are laid out for a 744px wide article column, where one SVG unit is one pixel,
 * so their text renders at its real size on desktop. Figure scrolls them on phones.
 */

const INK = "#14161b";
const GRAPHITE = "#5b616c";
const RULE = "#dcdfe5";
const WASH = "#f1f2f5";
const LIVE = "#e5484d";
const MANUAL = "#f5a524";

export const DIAGRAM_WIDTH = 744;

export function Svg({
  height,
  width = DIAGRAM_WIDTH,
  label,
  children,
}: {
  height: number;
  width?: number;
  /** What the diagram shows, for screen readers. */
  label: string;
  children: (marker: { arrow: string; arrowMuted: string; dot: string }) => ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const ids = { arrow: `${id}-arrow`, arrowMuted: `${id}-arrow-muted`, dot: `${id}-dot` };
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="block h-auto w-full"
    >
      <defs>
        <marker
          id={ids.arrow}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M1 1.2 9 5 1 8.8Z" fill={INK} />
        </marker>
        <marker
          id={ids.arrowMuted}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M1 1.2 9 5 1 8.8Z" fill={GRAPHITE} />
        </marker>
        <marker id={ids.dot} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">
          <circle cx="5" cy="5" r="4" fill={INK} />
        </marker>
      </defs>
      {children({
        arrow: `url(#${ids.arrow})`,
        arrowMuted: `url(#${ids.arrowMuted})`,
        dot: `url(#${ids.dot})`,
      })}
    </svg>
  );
}

export type Tone = "ink" | "sheet" | "wash" | "live" | "manual";

const tones: Record<Tone, { fill: string; stroke: string; title: string; sub: string }> = {
  ink: { fill: INK, stroke: INK, title: "#ffffff", sub: "rgba(255,255,255,0.66)" },
  sheet: { fill: "#ffffff", stroke: "#b9bec8", title: INK, sub: GRAPHITE },
  wash: { fill: WASH, stroke: RULE, title: INK, sub: GRAPHITE },
  live: { fill: "#fdeced", stroke: LIVE, title: INK, sub: GRAPHITE },
  manual: { fill: "#fef5e6", stroke: MANUAL, title: INK, sub: GRAPHITE },
};

/** A component: a rounded box with a title and up to a few lines of detail. */
export function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  tone = "sheet",
  align = "center",
  mono = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string | string[];
  tone?: Tone;
  align?: "center" | "top";
  /** Set the detail lines in the monospace font, for paths and ports. */
  mono?: boolean;
}) {
  const style = tones[tone];
  const lines = sub === undefined ? [] : Array.isArray(sub) ? sub : [sub];
  const lineHeight = 15;
  const block = 17 + lines.length * lineHeight;
  const top = align === "top" ? y + 22 : y + (h - block) / 2 + 13;
  return (
    <g>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={w - 1}
        height={h - 1}
        rx={10}
        fill={style.fill}
        stroke={style.stroke}
      />
      <text
        x={x + w / 2}
        y={top}
        textAnchor="middle"
        fontSize={13.5}
        fontWeight={600}
        fill={style.title}
      >
        {title}
      </text>
      {lines.map((line, i) => (
        <text
          key={i}
          x={x + w / 2}
          y={top + 17 + i * lineHeight}
          textAnchor="middle"
          fontSize={mono ? 11.25 : 12}
          className={mono ? "mono" : undefined}
          fill={style.sub}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

/** A boundary around components: a machine, a container, a network. */
export function Group({
  x,
  y,
  w,
  h,
  label,
  note,
  tone = "plain",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  note?: string;
  tone?: "plain" | "wash";
}) {
  return (
    <g>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={w - 1}
        height={h - 1}
        rx={14}
        fill={tone === "wash" ? "#f6f7f9" : "none"}
        stroke="#b9bec8"
        strokeDasharray="5 4"
      />
      <text
        x={x + 14}
        y={y + 21}
        fontSize={11}
        fontWeight={600}
        letterSpacing="0.07em"
        fill={GRAPHITE}
      >
        {label.toUpperCase()}
      </text>
      {note && (
        <text
          x={x + w - 14}
          y={y + 21}
          textAnchor="end"
          fontSize={11}
          className="mono"
          fill={GRAPHITE}
        >
          {note}
        </text>
      )}
    </g>
  );
}

/**
 * A connection: a polyline through `points`, optionally with arrowheads and a label.
 * Draw edges before boxes, so their ends tuck under the box borders.
 */
export function Edge({
  points,
  marker,
  start,
  dashed = false,
  muted = false,
  label,
  at,
  anchor = "middle",
  bridge = false,
}: {
  points: [number, number][];
  /** The marker for the end of the line, from Svg's render prop. */
  marker?: string;
  /** The marker for the start of the line, for two-way connections. */
  start?: string;
  dashed?: boolean;
  muted?: boolean;
  label?: string | string[];
  /** Where the label goes. Defaults to the middle of the first segment. */
  at?: [number, number];
  anchor?: "start" | "middle" | "end";
  /** Draw a white underlay, so this line shows a small gap where it crosses one drawn earlier. */
  bridge?: boolean;
}) {
  const d = points.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
  const [a, b] = [points[0]!, points[1] ?? points[0]!];
  const position = at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return (
    <g>
      {bridge && <path d={d} fill="none" stroke="#ffffff" strokeWidth={6} strokeLinejoin="round" />}
      <path
        d={d}
        fill="none"
        stroke={muted ? GRAPHITE : INK}
        strokeWidth={1.25}
        strokeDasharray={dashed ? "4 3.5" : undefined}
        markerEnd={marker}
        markerStart={start}
        strokeLinejoin="round"
      />
      {label && <Label x={position[0]} y={position[1]} anchor={anchor} lines={label} background />}
    </g>
  );
}

/** Text with a white halo, so it reads cleanly where it crosses a line. */
export function Label({
  x,
  y,
  lines,
  anchor = "middle",
  size = 11.5,
  color = GRAPHITE,
  weight = 400,
  mono = false,
  background = false,
}: {
  x: number;
  y: number;
  lines: string | string[];
  anchor?: "start" | "middle" | "end";
  size?: number;
  color?: string;
  weight?: number;
  mono?: boolean;
  /**
   * Paint a white panel behind the text, so a line running under it doesn't show between words.
   * SVG can't measure text while rendering on the server, so the width is a generous estimate.
   */
  background?: boolean;
}) {
  const all = Array.isArray(lines) ? lines : [lines];
  const lineHeight = size + 3.5;
  const top = y - ((all.length - 1) * lineHeight) / 2 + size * 0.35;
  const width = Math.max(...all.map((line) => line.length)) * size * (mono ? 0.6 : 0.5) + 6;
  const height = all.length * lineHeight + 2;
  const left = anchor === "start" ? x - 3 : anchor === "end" ? x - width + 3 : x - width / 2;
  const text = (
    <text
      textAnchor={anchor}
      fontSize={size}
      fontWeight={weight}
      fill={color}
      stroke="#ffffff"
      strokeWidth={4}
      strokeLinejoin="round"
      paintOrder="stroke"
      className={mono ? "mono" : undefined}
    >
      {all.map((line, i) => (
        <tspan key={i} x={x} y={top + i * lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
  if (!background) return text;
  return (
    <g>
      <rect x={left} y={y - height / 2} width={width} height={height} rx={4} fill="#ffffff" />
      {text}
    </g>
  );
}

/** A state in a state diagram: a pill. */
export function State({
  x,
  y,
  w = 116,
  h = 38,
  label,
  tone = "sheet",
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  tone?: Tone;
}) {
  const style = tones[tone];
  return (
    <g>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={w - 1}
        height={h - 1}
        rx={h / 2}
        fill={style.fill}
        stroke={style.stroke}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 4.5}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        className="mono"
        fill={style.title}
      >
        {label}
      </text>
    </g>
  );
}

export const palette = { INK, GRAPHITE, RULE, WASH, LIVE, MANUAL };
