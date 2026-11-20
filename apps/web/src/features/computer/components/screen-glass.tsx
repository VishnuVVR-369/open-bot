"use client";

import { CloudOff, Expand, Loader2, Maximize2, Moon, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScreenView, type ScreenConnection, type ScreenHandle } from "./screen-view";
import { useComputer } from "../hooks";
import { ScreenBadge, EgressChip, rimColor, WakeButton } from "./screen-status";

/** The icon above a dark screen's message: a small lit tile. */
function GlassIcon({ children }: { children: ReactNode }) {
  return (
    <span className="mb-2 flex size-11 items-center justify-center rounded-[13px] bg-white/[0.05] text-bezel-foreground/80 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/[0.08] [&_svg]:size-5">
      {children}
    </span>
  );
}

/** The glass: the teammate's live screen, or why it isn't showing. */
export function ScreenGlass({
  screenId,
  initial,
  className,
  handleRef,
}: {
  screenId: string;
  initial?: AppState;
  className?: string;
  handleRef?: React.RefObject<ScreenHandle | null>;
}) {
  const { screen, workerOnline, online, lifecycle } = useComputer(initial);
  const info = screen(screenId);
  const youHaveControl = info?.activity === "you";
  const running = info?.status?.state === "running";
  const [connection, setConnection] = useState<ScreenConnection>("connecting");
  // The "your input controls the screen" hint shows briefly, then gets out of the way.
  const [hintVisible, setHintVisible] = useState(false);
  useEffect(() => {
    if (!youHaveControl || connection !== "connected") {
      setHintVisible(false);
      return;
    }
    setHintVisible(true);
    const timer = setTimeout(() => setHintVisible(false), 3500);
    return () => clearTimeout(timer);
  }, [youHaveControl, connection]);

  let placeholder: ReactNode = null;
  if (!workerOnline || !online) {
    placeholder = (
      <>
        <GlassIcon>
          <CloudOff />
        </GlassIcon>
        <span className="text-[14px] font-medium text-bezel-foreground">
          The computer is offline
        </span>
        <span className="max-w-80 text-[12.5px] leading-relaxed text-bezel-foreground/85">
          {info
            ? `${info.teammate.name} pauses computer work until it's back. It reconnects on its own.`
            : "It reconnects on its own."}
        </span>
      </>
    );
  } else if (
    lifecycle?.enabled &&
    (lifecycle.phase === "idle" || lifecycle.phase === "waking" || lifecycle.phase === "quiescing")
  ) {
    // While the computer is awake its screens show as usual. An error only explains why it's idle.
    const waking = lifecycle.phase === "waking";
    const error = lifecycle.phase === "idle" ? lifecycle.error : null;
    placeholder = (
      <>
        <GlassIcon>
          {waking ? (
            <Loader2 className="animate-spin" />
          ) : error ? (
            <TriangleAlert className="text-destructive" />
          ) : (
            <Moon />
          )}
        </GlassIcon>
        <span role="status" className="text-[14px] font-medium text-bezel-foreground">
          {error
            ? "Computer error"
            : waking
              ? "Waking computer…"
              : lifecycle.phase === "quiescing"
                ? "Computer going idle"
                : "Computer idle"}
        </span>
        {!waking && (
          <>
            {/* Three lines at most, so the Wake button stays on a phone-sized screen. */}
            <span
              title={error ?? undefined}
              className="line-clamp-3 max-w-72 text-[12.5px] leading-relaxed [overflow-wrap:anywhere]"
            >
              {error ?? "Your next task or Wake screen will start it."}
            </span>
            <div className="mt-2.5">
              <WakeButton screenId={screenId} />
            </div>
          </>
        )}
      </>
    );
  } else if (info && !running) {
    const starting = info.status?.state === "starting";
    placeholder = (
      <>
        <GlassIcon>{starting ? <Loader2 className="animate-spin" /> : <Moon />}</GlassIcon>
        <span className="text-[14px] font-medium text-bezel-foreground">
          {starting
            ? `Starting ${info.teammate.name}'s screen…`
            : `${info.teammate.name}'s screen is asleep`}
        </span>
        {!starting && (
          <>
            <span className="max-w-72 text-[12.5px] leading-relaxed">
              It wakes up when {info.teammate.name} uses the screen, or when you take over.
            </span>
            <div className="mt-2.5">
              <WakeButton screenId={screenId} />
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-[#050506]",
        className,
      )}
      data-activity={info?.activity ?? "none"}
      data-testid="computer-screen"
    >
      {placeholder === null ? (
        <ScreenView
          key={screenId}
          screenId={screenId}
          mode={youHaveControl ? "control" : "view"}
          onStatus={setConnection}
          handleRef={handleRef}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center text-bezel-foreground/65">
          {/* A dimmed display: a faint glow from above over a fine dot grid. */}
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.07)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)] bg-[size:16px_16px]"
          />
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_-10%,rgb(255_255_255/0.08),transparent_60%)]"
          />
          <div className="relative flex flex-col items-center gap-1.5">{placeholder}</div>
        </div>
      )}
      <div
        aria-hidden={!hintVisible}
        className={cn(
          "pointer-events-none absolute top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-attention px-3 py-1 text-[11.5px] font-semibold whitespace-nowrap text-black shadow-lg transition-all duration-500",
          hintVisible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
        )}
      >
        Your mouse and keyboard control this screen
      </div>
    </div>
  );
}

/** The monitor: a dark bezel whose rim takes the color of whoever is using the screen. */
export function ScreenFrame({
  screenId,
  initial,
  handleRef,
  className,
  expand = false,
}: {
  screenId: string;
  initial?: AppState;
  handleRef?: React.RefObject<ScreenHandle | null>;
  className?: string;
  /** Offer a way to the full computer page. */
  expand?: boolean;
}) {
  const { screen } = useComputer(initial);
  const info = screen(screenId);
  const rim = rimColor(info);
  const frameRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={frameRef}
      className={cn(
        "flex flex-col gap-2 rounded-[22px] bg-bezel p-2.5 transition-shadow duration-500 dark:outline dark:outline-1 dark:outline-white/[0.07] [&:fullscreen]:justify-center [&:fullscreen]:rounded-none [&:fullscreen]:p-6",
        className,
      )}
      style={{
        boxShadow: `0 0 0 2px ${rim}, 0 0 0 6px color-mix(in oklab, ${rim} 20%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.06), 0 2px 4px rgb(0 0 0 / 0.08), 0 28px 56px -28px rgb(0 0 0 / 0.45)`,
      }}
    >
      <div className="flex h-7 items-center justify-between gap-2 pr-0.5 pl-1.5">
        {info ? <ScreenBadge info={info} /> : <span />}
        <div className="flex items-center">
          <EgressChip initial={initial} />
          {expand && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={`/computer?screen=${screenId}`}
                  aria-label="Open the computer"
                  className="flex size-7 items-center justify-center rounded-full text-bezel-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-bezel-foreground"
                >
                  <Expand className="size-3.5" />
                </Link>
              </TooltipTrigger>
              <TooltipContent>Open the computer</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex size-7 items-center justify-center rounded-full text-bezel-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-bezel-foreground"
                aria-label="Full screen"
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else void frameRef.current?.requestFullscreen?.();
                }}
              >
                <Maximize2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Full screen</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScreenGlass screenId={screenId} initial={initial} handleRef={handleRef} />
    </div>
  );
}
