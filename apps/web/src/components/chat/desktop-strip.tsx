"use client";

import { SCREEN, type ComputerAction, type ComputerItem } from "@open-bot/shared";
import { ChevronLeft, ChevronRight, Monitor, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function host(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function describeAction(action: ComputerAction): string {
  switch (action.action) {
    case "screenshot":
      return "Looked at the screen";
    case "click":
      return action.clicks === 2
        ? "Double-clicked"
        : action.button === "right"
          ? "Right-clicked"
          : action.clicks === 3
            ? "Triple-clicked"
            : "Clicked";
    case "move":
      return "Pointed";
    case "drag":
      return "Dragged";
    case "scroll":
      return `Scrolled ${action.direction}`;
    case "type": {
      const text = action.text.replace(/\s+/g, " ");
      return `Typed “${text.length > 28 ? `${text.slice(0, 28)}…` : text}”`;
    }
    case "key":
      return `Pressed ${action.keys
        .split(/\s+/)
        .map((combo) =>
          combo
            .split("+")
            .map((k) => (k.length === 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1)))
            .join("+"),
        )
        .join(", ")}`;
    case "open_url":
      return `Opened ${host(action.url)}`;
    case "wait":
      return `Waited ${action.seconds}s`;
  }
}

/** Where on the screen an action happened, as percentages, for the marker. */
function actionPoints(action: ComputerAction): { x: number; y: number }[] {
  const at = (x: number, y: number) => ({
    x: (x / SCREEN.width) * 100,
    y: (y / SCREEN.height) * 100,
  });
  switch (action.action) {
    case "click":
    case "move":
    case "scroll":
      return [at(action.x, action.y)];
    case "drag":
      return [at(action.fromX, action.fromY), at(action.toX, action.toY)];
    default:
      return [];
  }
}

function Marker({ action, large = false }: { action: ComputerAction; large?: boolean }) {
  const points = actionPoints(action);
  if (points.length === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {points.length === 2 && (
        <line
          x1={points[0]!.x}
          y1={points[0]!.y}
          x2={points[1]!.x}
          y2={points[1]!.y}
          stroke="var(--live)"
          strokeWidth={large ? 0.35 : 0.8}
          strokeDasharray="1.5 1"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points.map((point, index) => (
        <g key={index}>
          <ellipse
            cx={point.x}
            cy={point.y}
            rx={large ? 1.6 : 4}
            ry={large ? 2.56 : 6.4}
            fill="color-mix(in oklab, var(--live) 25%, transparent)"
            stroke="var(--live)"
            strokeWidth={large ? 2 : 1.5}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

function Shot({ item, large = false }: { item: ComputerItem; large?: boolean }) {
  if (!item.screenshotId) {
    // An action that didn't happen has no screenshot; say why.
    const reason = large && item.status === "failed" ? item.error : undefined;
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-bezel px-6 text-center text-bezel-foreground/50">
        <Monitor className={large ? "size-8" : "size-4"} />
        {reason && (
          <span className="max-w-96 text-[13.5px] text-bezel-foreground/75">
            Didn’t happen: {reason}
          </span>
        )}
      </div>
    );
  }
  return (
    <>
      <img
        src={`/api/artifacts/${item.screenshotId}`}
        alt={describeAction(item.action)}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <Marker action={item.action} large={large} />
    </>
  );
}

/** How long each frame shows during a replay. */
const FRAME_MS = 1400;

/** Consecutive desktop actions, as a filmstrip of screenshots you can replay. */
export function DesktopStrip({ items, live }: { items: ComputerItem[]; live: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const last = items.length - 1;

  // Replay: step through the frames, and stop at the end.
  useEffect(() => {
    if (!playing || open === null) return;
    if (open >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setOpen(open + 1), FRAME_MS);
    return () => clearTimeout(timer);
  }, [playing, open, last]);

  // Load the next frame ahead, so the replay doesn't flicker.
  const upcoming = open === null ? undefined : items[open + 1]?.screenshotId;
  useEffect(() => {
    if (upcoming) new Image().src = `/api/artifacts/${upcoming}`;
  }, [upcoming]);

  const go = (index: number) => {
    setPlaying(false);
    setOpen(Math.max(0, Math.min(last, index)));
  };
  const failed = items.filter((item) => item.status === "failed");

  // Keep the newest frame in view while the bot works.
  useEffect(() => {
    if (live && scroller.current)
      scroller.current.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" });
  }, [items.length, live]);

  const current = open === null ? null : items[open];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-6 items-center gap-2 text-[13px] text-muted-foreground">
        <Monitor className="size-3.5" />
        <span>
          Used the desktop
          <span className="text-muted-foreground/70">
            {" "}
            · {items.length} {items.length === 1 ? "action" : "actions"}
          </span>
        </span>
        {!live && items.length > 1 && (
          <button
            onClick={() => {
              setOpen(0);
              setPlaying(true);
            }}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] transition-colors hover:bg-muted hover:text-foreground"
            data-testid="replay"
          >
            <Play className="size-3 fill-current" />
            Replay
          </button>
        )}
      </div>
      <div
        ref={scroller}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1.5 [scrollbar-width:thin]"
      >
        {items.map((item, index) => {
          const running = item.status === "running";
          return (
            <button
              key={item.id}
              onClick={() => go(index)}
              className="group flex w-[148px] shrink-0 flex-col gap-1.5 text-left focus-visible:outline-none"
              aria-label={`${describeAction(item.action)}. Open screenshot.`}
            >
              <span
                className={cn(
                  "relative block aspect-[16/10] w-full overflow-hidden rounded-[8px] bg-bezel ring-1 ring-border transition-all group-hover:ring-foreground/40 group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  item.status === "failed" && "ring-destructive/50",
                )}
              >
                {running ? (
                  <span className="absolute inset-0 animate-pulse bg-bezel" />
                ) : (
                  <Shot item={item} />
                )}
              </span>
              <span
                className={cn(
                  "truncate text-[12px] leading-tight text-muted-foreground",
                  running && "text-foreground",
                  item.status === "failed" && "text-destructive",
                )}
              >
                {running ? `${describeAction(item.action)}…` : describeAction(item.action)}
              </span>
            </button>
          );
        })}
      </div>
      {failed.length > 0 && failed.at(-1)?.error && (
        <p className="text-[12.5px] text-muted-foreground">Stopped: {failed.at(-1)!.error}</p>
      )}
      <Dialog
        open={current !== null && current !== undefined}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(null);
          setPlaying(false);
        }}
      >
        <DialogContent
          className="max-w-[min(1100px,calc(100vw-2rem))] gap-3 p-3 sm:max-w-[min(1100px,calc(100vw-2rem))]"
          onKeyDown={(event) => {
            if (open === null) return;
            if (event.key === "ArrowRight") go(open + 1);
            if (event.key === "ArrowLeft") go(open - 1);
            if (event.key === " ") {
              event.preventDefault();
              if (open >= last) setOpen(0);
              setPlaying((value) => !value);
            }
          }}
          data-testid="replay-viewer"
        >
          {current && open !== null && (
            <>
              <DialogTitle className="px-1 pt-1 text-[14px] font-medium">
                {describeAction(current.action)}
                <span className="ml-2 font-mono text-[12px] font-normal text-muted-foreground">
                  {open + 1} / {items.length}
                </span>
              </DialogTitle>
              {current.action.action === "type" && (
                <code className="-mt-1 w-fit max-w-full justify-self-start truncate rounded bg-muted px-2 py-0.5 font-mono text-xs">
                  {current.action.text}
                </code>
              )}
              <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-bezel">
                <Shot item={current} large />
              </div>
              {items.length > 1 && (
                <div className="flex h-1.5 gap-0.5 px-1" aria-hidden>
                  {items.map((item, index) => (
                    <button
                      key={item.id}
                      tabIndex={-1}
                      onClick={() => go(index)}
                      className={cn(
                        "h-full flex-1 rounded-full transition-colors",
                        index <= open ? "bg-foreground/70" : "bg-muted hover:bg-foreground/25",
                        item.status === "failed" && "bg-destructive/60",
                      )}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 px-1">
                <button
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => go(open - 1)}
                  disabled={open === 0}
                >
                  <ChevronLeft className="size-4" /> Previous
                </button>
                <span className="flex min-w-0 flex-1 justify-center">
                  {items.length > 1 && (
                    <button
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        if (open >= last) setOpen(0);
                        setPlaying((value) => !value);
                      }}
                      aria-label={playing ? "Pause the replay" : "Play the replay"}
                    >
                      {playing ? (
                        <Pause className="size-3.5 fill-current" />
                      ) : (
                        <Play className="size-3.5 fill-current" />
                      )}
                      {playing ? "Pause" : open >= last ? "Replay" : "Play"}
                    </button>
                  )}
                </span>
                <button
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => go(open + 1)}
                  disabled={open === last}
                >
                  Next <ChevronRight className="size-4" />
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
