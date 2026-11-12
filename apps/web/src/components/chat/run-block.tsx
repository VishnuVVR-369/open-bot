"use client";

import {
  elapsed,
  isPinned,
  replyText,
  triggerLabel,
  turnParts,
  workDuration,
  workingText,
  workSummary,
  type TriggerKind,
} from "@open-bot/chat-core";
import { formatDollars, isNothingToReport, isRunActive, type TimelineItem } from "@open-bot/domain";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowRightLeft,
  Brain,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  Eye,
  KeyRound,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  MessageCircleReply,
  MoreHorizontal,
  Network,
  RotateCcw,
  ShieldCheck,
  Square,
  Undo2,
  Volume2,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import { readAloud, readingNow, stopReading, useReadAloud } from "@/lib/client/read-aloud";
import type { BotSummary, RunView } from "@/lib/types";
import { cn, compactNumber, formatDuration, REVEAL_ON_RUN_HOVER } from "@/lib/utils";
import { RunMemory } from "@/components/memory/run-memory";
import { PageCard } from "@/components/pages/page-card";
import { SwarmCard } from "./swarm-card";
import { DesktopStrip } from "./desktop-strip";
import {
  ApprovalCard,
  CommandStep,
  FileChangeStep,
  HandoffStep,
  PlanCard,
  ReasoningStep,
  SteeredMessage,
  TakeoverRequestCard,
  ToolStep,
  WebSearchStep,
} from "./items";
import { Markdown } from "./markdown";
import { ReplyFeedback } from "./reply-feedback";

/** A reply action: a 32px target with a 16px glyph, quiet until you point at the reply. */
const ACTION = "size-8 text-muted-foreground [&_svg:not([class*='size-'])]:size-4";

/** Copies the reply. */
function CopyReply({ text }: { text: string }) {
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
function MoreActions({ runId, text }: { runId: string; text: string }) {
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
function RunTime({ run, showDuration = true }: { run: RunView; showDuration?: boolean }) {
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
function RetryRun({ runId }: { runId: string }) {
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

/** Each trigger's icon; the words come from `triggerLabel` (packages/chat-core). */
const TRIGGER_ICONS: Record<TriggerKind, typeof CalendarClock> = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
  hand_back: Undo2,
  approval: ShieldCheck,
  handoff: ArrowRightLeft,
  question: MessageCircleQuestion,
  answer: MessageCircleReply,
  task: ListTodo,
  email: Mail,
  swarm: Network,
  swarm_results: Network,
};

/** What started the run: an automation opens what it gave the teammate, a task links the board. */
function TriggerLabel({ run, bots }: { run: RunView; bots: BotSummary[] }) {
  const label = triggerLabel(run, bots);
  if (!label) return null;
  const Icon = TRIGGER_ICONS[label.kind];
  const content = (
    <>
      <Icon className="size-3.5" />
      {label.text}
    </>
  );
  if (label.automation && run.automationPrompt)
    return (
      <Popover>
        <PopoverTrigger
          className="-mx-1 flex items-center gap-1 rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="automation-label"
        >
          {content}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] gap-2 p-0">
          <div className="border-b px-3.5 py-2.5 text-[12.5px] font-medium text-muted-foreground">
            What started this
          </div>
          <div className="max-h-80 overflow-y-auto px-3.5 pb-3">
            <Markdown text={run.automationPrompt} className="text-[13px]" />
          </div>
        </PopoverContent>
      </Popover>
    );
  if (label.kind === "task")
    return (
      <Link
        href="/tasks"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        data-testid="run-trigger"
      >
        {content}
      </Link>
    );
  return (
    <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
      {content}
    </span>
  );
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-[12px] tabular-nums">
      {elapsed(now - new Date(since).getTime())}
    </span>
  );
}

function WorkingLine({ run }: { run: RunView }) {
  const { status } = run.timeline;
  // The approval or takeover card above already says what the run needs from you.
  if (status === "waiting") return null;
  // A running turn's steps show right above, so the line doesn't repeat the latest one.
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "queued" ? "bg-idle" : "animate-tally bg-working",
        )}
      />
      <span>{workingText(run, { activity: false })}</span>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </div>
  );
}

function renderItem(
  item: TimelineItem,
  botId: string,
  bot: BotSummary | undefined,
  approved = false,
) {
  switch (item.kind) {
    case "message":
      return item.phase === "final" ? (
        <Markdown text={item.text} className="text-[14.5px] text-foreground" />
      ) : (
        <Markdown text={item.text} className="text-[13.5px] text-muted-foreground" />
      );
    case "reasoning":
      return item.text ? <ReasoningStep item={item} /> : null;
    case "command":
      return <CommandStep item={item} approved={approved} />;
    case "file_change":
      return <FileChangeStep item={item} />;
    case "tool":
      return <ToolStep item={item} />;
    case "web_search":
      return <WebSearchStep item={item} />;
    case "plan":
      return <PlanCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} botName={bot?.name ?? "Your teammate"} />;
    case "takeover_request":
      return (
        <TakeoverRequestCard item={item} botId={botId} botName={bot?.name ?? "Your teammate"} />
      );
    case "handoff":
      return <HandoffStep item={item} />;
    case "user_message":
      return <SteeredMessage item={item} />;
    case "swarm":
      return <SwarmCard item={item} botName={bot?.name ?? "Your teammate"} />;
    case "page":
      return <PageCard item={item} />;
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-[13.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {item.message}
        </div>
      );
    case "computer":
      return null;
  }
}

export function RunBlock({
  run,
  chatId,
  bot,
  bots,
  superseded = false,
  latest = false,
}: {
  run: RunView;
  chatId: string;
  bot: BotSummary | undefined;
  bots: BotSummary[];
  /** The same bot ran again after this, so there's nothing to retry. */
  superseded?: boolean;
  /** The last entry in the chat: its actions always show. */
  latest?: boolean;
}) {
  const active = isRunActive(run.timeline.status);
  const items = run.timeline.items;
  // A stretch of computer use is one step, as it shows as one strip.
  const { parts, approved, steps: stepCount } = useMemo(() => turnParts(items), [items]);
  // A finished run folds its steps into one line, the same as on the phone, so the chat reads as a
  // conversation; what you need to see (the reply, a pending approval, an error, a page) stays out.
  // A run that is still going shows its steps as they happen.
  const collapsible = !active && stepCount > 0;
  const [expanded, setExpanded] = useState(false);
  const showSteps = !collapsible || expanded;
  const name = bot?.name ?? "Former teammate";
  const reply = replyText(items);
  // A reply's actions sit in one row under it, the same with a mouse or a finger.
  const actions = !active && (
    <span
      className={cn(
        "-ml-2 flex items-center gap-0.5 [&_button:not([aria-pressed=true]):not([aria-expanded=true])]:text-faint",
        // The latest reply's row is part of it. An earlier reply's row, shown on hover, sits in the
        // space after it instead of holding that space open between every message. On a touch
        // screen every row shows, so each keeps its place.
        latest ? "-mt-1" : "absolute top-full left-0 -mt-1 pointer-coarse:static",
      )}
      data-testid="run-actions"
    >
      {reply && <CopyReply text={reply} />}
      {reply && run.timeline.status === "completed" && bot && (
        <ReplyFeedback run={run} botName={name} chatId={chatId} />
      )}
      <MoreActions runId={run.id} text={reply} />
    </span>
  );

  // A routine that looked and found nothing needs no more than a line.
  if (!active && run.trigger === "schedule" && isNothingToReport(reply)) {
    return (
      <article
        id={`run-${run.id}`}
        className="flex scroll-mt-6 items-center gap-3 py-0.5 text-[13px] text-muted-foreground"
        data-testid="run"
        data-status={run.timeline.status}
        data-quiet
      >
        <span className="flex w-9 shrink-0 justify-center">
          <BotAvatar name={name} color={bot?.color ?? "#888888"} emoji={bot?.emoji} size="xs" />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="font-medium text-foreground/80">{name}</span>
          <TriggerLabel run={run} bots={bots} />
          <span>· Nothing to report</span>
          <RunTime run={run} />
        </span>
      </article>
    );
  }

  return (
    <article
      id={`run-${run.id}`}
      className="group/run flex scroll-mt-6 gap-3"
      data-latest={latest || undefined}
      data-testid="run"
      data-status={run.timeline.status}
    >
      <BotAvatar
        name={name}
        color={bot?.color ?? "#888888"}
        emoji={bot?.emoji}
        size="md"
        className="mt-0.5"
      />
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex h-6 items-center gap-2 text-[13px]">
          <span className="text-[14px] font-semibold">{name}</span>
          <TriggerLabel run={run} bots={bots} />
          {run.authMode === "api_key" && (
            <span className="flex items-center gap-1 rounded-full bg-subtle px-2 py-px text-[11.5px] text-muted-foreground">
              <KeyRound className="size-3" />
              API key
            </span>
          )}
          <RunTime run={run} showDuration={!collapsible} />
        </header>

        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1 flex h-7 items-center gap-1.5 self-start rounded-md px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground/80"
            aria-expanded={expanded}
            data-testid="run-steps"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
            />
            {workSummary(workDuration(run), stepCount)}
          </button>
        )}

        <div className="flex flex-col gap-1.5">
          {parts.map((part) => {
            if (part.kind === "computer") {
              return showSteps ? (
                <div key={part.id} className="my-1">
                  <DesktopStrip items={part.items} live={active} />
                </div>
              ) : null;
            }
            if (!showSteps && !isPinned(part.item)) return null;
            const content = renderItem(part.item, run.botId, bot, approved.has(part.item.id));
            if (!content) return null;
            const spaced =
              part.item.kind === "message" ||
              part.item.kind === "approval" ||
              part.item.kind === "takeover_request" ||
              part.item.kind === "plan" ||
              part.item.kind === "swarm" ||
              part.item.kind === "page" ||
              part.item.kind === "user_message";
            return (
              <div key={part.id} className={cn(spaced && "my-1")}>
                {content}
              </div>
            );
          })}
        </div>

        {active && <WorkingLine run={run} />}
        {run.timeline.status === "interrupted" && (
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Square className="size-3" />
            {run.timeline.error ?? `You stopped ${name}.`}
          </div>
        )}
        {!superseded &&
          (run.timeline.status === "failed" || run.timeline.status === "interrupted") && (
            <RetryRun runId={run.id} />
          )}
        {actions}
      </div>
    </article>
  );
}
