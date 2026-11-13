"use client";

import { formatDollars } from "@open-bot/domain";
import { format } from "date-fns";
import { Brain, Check, Copy, MoreHorizontal, RotateCcw, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import { readAloud, readingNow, stopReading, useReadAloud } from "@/lib/client/read-aloud";
import type { RunView } from "@/lib/types";
import { cn, compactNumber, formatDuration, REVEAL_ON_RUN_HOVER } from "@/lib/utils";
import { RunMemory } from "@/features/memory";

/** A reply action: a 32px target with a 16px glyph, quiet until you point at the reply. */
const ACTION = "size-8 text-muted-foreground [&_svg:not([class*='size-'])]:size-4";

/** Copies the reply. */
export function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy reply"
          className={cn(ACTION, REVEAL_ON_RUN_HOVER)}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The reply's less common actions, by name: which memories it was given, and reading it aloud.
 * While it's being read, a stop button stays in the row.
 */
export function MoreActions({ runId, text }: { runId: string; text: string }) {
  const { supported, speaking } = useReadAloud();
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Picked in the menu: the popover opens once the menu has closed, or the closing would dismiss it.
  const openMemory = useRef(false);
  const reading = speaking === runId;
  // A reply that leaves the screen stops being read, since its stop button goes with it.
  useEffect(
    () => () => {
      if (readingNow() === runId) stopReading();
    },
    [runId],
  );
  return (
    <>
      {reading && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Stop reading"
              aria-pressed
              className={cn(ACTION, "text-foreground")}
              onClick={stopReading}
              data-testid="stop-reading"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop reading</TooltipContent>
        </Tooltip>
      )}
      <RunMemory runId={runId} open={memoryOpen} onOpenChange={setMemoryOpen}>
        <span className="flex">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="More actions"
                    className={cn(ACTION, memoryOpen ? "text-foreground" : REVEAL_ON_RUN_HOVER)}
                    data-testid="reply-more"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>More</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              className="w-56"
              onCloseAutoFocus={(event) => {
                if (!openMemory.current) return;
                // The memory popover takes over from the menu, focus and all.
                event.preventDefault();
                openMemory.current = false;
                setMemoryOpen(true);
              }}
            >
              <DropdownMenuItem onSelect={() => (openMemory.current = true)}>
                <Brain />
                What they remembered
              </DropdownMenuItem>
              {supported && text && (
                <DropdownMenuItem
                  onSelect={() => (reading ? stopReading() : readAloud(runId, text))}
                  data-testid="read-aloud"
                >
                  {reading ? <Square className="fill-current" /> : <Volume2 />}
                  {reading ? "Stop reading" : "Read aloud"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </RunMemory>
    </>
  );
}

/** When the run started and, once done, how long it took and what it used. */
export function RunTime({ run, showDuration = true }: { run: RunView; showDuration?: boolean }) {
  const took =
    run.startedAt && run.completedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  const details = [
    took !== null && `Took ${formatDuration(took)}`,
    run.usage && run.usage.tokens > 0 && `${compactNumber(run.usage.tokens)} tokens`,
    run.usage &&
      run.usage.costMicros > 0 &&
      `${formatDollars(run.usage.costMicros)} on your API key`,
  ].filter(Boolean);
  const time = (
    <time
      className="text-[12px] whitespace-nowrap text-muted-foreground"
      dateTime={run.createdAt}
      data-testid="run-time"
    >
      {format(new Date(run.createdAt), "h:mm a")}
      {showDuration && took !== null && ` · ${formatDuration(took)}`}
    </time>
  );
  if (details.length === 0) return time;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{time}</TooltipTrigger>
      <TooltipContent data-testid="run-stats">
        {format(new Date(run.createdAt), "EEE, MMM d, h:mm a")} · {details.join(" · ")}
      </TooltipContent>
    </Tooltip>
  );
}

/** Runs a failed or stopped request again. */
export function RetryRun({ runId }: { runId: string }) {
  const [retrying, startRetry] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 gap-1.5 self-start px-2 text-[13px] text-muted-foreground"
      disabled={retrying}
      onClick={() =>
        startRetry(async () => {
          const result = await attempt(api.runs.retry({ runId }));
          if (!result.ok) toast.error("Couldn't try again", { description: result.error });
        })
      }
      data-testid="retry-run"
    >
      <RotateCcw className={cn("size-3.5", retrying && "animate-spin")} />
      Try again
    </Button>
  );
}
