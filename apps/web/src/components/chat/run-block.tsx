"use client";

import {
  formatDollars,
  isNothingToReport,
  isRunActive,
  type ComputerItem,
  type TimelineItem,
} from "@open-bot/shared";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Eye,
  KeyRound,
  ListTodo,
  Mail,
  MessageCircleQuestion,
  MessageCircleReply,
  Network,
  RotateCcw,
  ShieldCheck,
  Square,
  Undo2,
  Volume2,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { retryRun } from "@/lib/actions";
import { readAloud, readingNow, stopReading, useReadAloud } from "@/lib/client/read-aloud";
import type { BotSummary, RunView } from "@/lib/types";
import { cn, compactNumber, formatDuration, REVEAL_ON_RUN_HOVER } from "@/lib/utils";
import { RunMemory } from "@/components/memory/run-memory";
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

/** The bot's reply as text, for copying. */
function replyText(run: RunView): string {
  return run.timeline.items
    .filter((item) => item.kind === "message")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Copies the reply. Sits in the header, shown on hover like the time, so it takes no room. */
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy reply"
          className={cn("text-muted-foreground", REVEAL_ON_RUN_HOVER)}
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

/** Reads the reply aloud, or stops reading it. */
function ReadAloud({ runId, text }: { runId: string; text: string }) {
  const { supported, speaking } = useReadAloud();
  // A reply that leaves the screen stops being read, since its stop button goes with it.
  useEffect(
    () => () => {
      if (readingNow() === runId) stopReading();
    },
    [runId],
  );
  if (!supported) return null;
  const reading = speaking === runId;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={reading ? "Stop reading" : "Read aloud"}
          aria-pressed={reading}
          className={cn("text-muted-foreground", reading ? "text-foreground" : REVEAL_ON_RUN_HOVER)}
          onClick={() => (reading ? stopReading() : readAloud(runId, text))}
          data-testid="read-aloud"
        >
          {reading ? <Square className="fill-current" /> : <Volume2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{reading ? "Stop reading" : "Read aloud"}</TooltipContent>
    </Tooltip>
  );
}

/** When the run started and, once done, how long it took and what it used. */
function RunTime({ run }: { run: RunView }) {
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
      className={cn("text-[12px] whitespace-nowrap text-muted-foreground/80", REVEAL_ON_RUN_HOVER)}
      dateTime={run.createdAt}
      data-testid="run-time"
    >
      {format(new Date(run.createdAt), "HH:mm")}
      {took !== null && ` · ${formatDuration(took)}`}
    </time>
  );
  if (details.length === 0) return time;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{time}</TooltipTrigger>
      <TooltipContent data-testid="run-stats">
        {format(new Date(run.createdAt), "EEE d MMM, HH:mm")} · {details.join(" · ")}
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
          const result = await retryRun(runId);
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

type Segment =
  | { kind: "desktop"; id: string; items: ComputerItem[] }
  | { kind: "item"; id: string; item: TimelineItem };

function segment(items: TimelineItem[]): Segment[] {
  const segments: Segment[] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (item.kind === "computer") {
      if (last?.kind === "desktop") last.items.push(item);
      else segments.push({ kind: "desktop", id: item.id, items: [item] });
    } else {
      segments.push({ kind: "item", id: item.id, item });
    }
  }
  return segments;
}

/** Items that always stay visible, even when the steps are collapsed. */
function isPinned(item: TimelineItem): boolean {
  return (
    (item.kind === "message" && item.phase === "final") ||
    item.kind === "user_message" ||
    item.kind === "error" ||
    item.kind === "swarm" ||
    (item.kind === "approval" && item.decision === "pending") ||
    (item.kind === "takeover_request" &&
      (item.resolution === "pending" || item.resolution === "taken"))
  );
}

/** An automation's name; opens what it gave the teammate, like the request a webhook received. */
function AutomationLabel({
  run,
  icon: Icon,
  title,
}: {
  run: RunView;
  icon: typeof CalendarClock;
  title: string;
}) {
  if (!run.automationPrompt)
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </span>
    );
  return (
    <Popover>
      <PopoverTrigger
        className="-mx-1 flex items-center gap-1 rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="automation-label"
      >
        <Icon className="size-3.5" />
        {title}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] gap-2 p-0">
        <div className="border-b px-3.5 py-2.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          What started this
        </div>
        <div className="max-h-80 overflow-y-auto px-3.5 pb-3">
          <Markdown text={run.automationPrompt} className="text-[13px]" />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TriggerLabel({ run, bots }: { run: RunView; bots: BotSummary[] }) {
  switch (run.trigger) {
    case "schedule":
      return (
        <AutomationLabel
          run={run}
          icon={CalendarClock}
          title={run.scheduleTitle ?? "Scheduled task"}
        />
      );
    case "watch":
      return <AutomationLabel run={run} icon={Eye} title={run.triggerTitle ?? "Page watch"} />;
    case "webhook":
      return <AutomationLabel run={run} icon={Webhook} title={run.triggerTitle ?? "Webhook"} />;
    case "hand_back":
      return (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Undo2 className="size-3.5" />
          After you handed back
        </span>
      );
    case "approval":
      return (
        <span className="flex items-center gap-1 text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          After your decision
        </span>
      );
    case "handoff": {
      const from = bots.find((bot) => bot.id === run.fromBotId);
      return (
        <span className="flex items-center gap-1 text-muted-foreground">
          <ArrowRightLeft className="size-3.5" />
          {from ? `From ${from.name}` : "Handed over"}
        </span>
      );
    }
    case "question": {
      const from = bots.find((bot) => bot.id === run.fromBotId);
      return (
        <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
          <MessageCircleQuestion className="size-3.5" />
          {from ? `${from.name} asked` : "A teammate asked"}
        </span>
      );
    }
    case "task":
      return (
        <Link
          href="/tasks"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          data-testid="run-trigger"
        >
          <ListTodo className="size-3.5" />
          From the task board
        </Link>
      );
    case "answer": {
      const from = bots.find((bot) => bot.id === run.fromBotId);
      return (
        <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
          <MessageCircleReply className="size-3.5" />
          {from ? `${from.name} answered` : "A teammate answered"}
        </span>
      );
    }
    case "email":
      return (
        <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
          <Mail className="size-3.5" />
          An email
        </span>
      );
    case "swarm":
      return (
        <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
          <Network className="size-3.5" />
          Swarm helper
        </span>
      );
    case "swarm_results":
      return (
        <span className="flex items-center gap-1 text-muted-foreground" data-testid="run-trigger">
          <Network className="size-3.5" />
          With the helpers&apos; results
        </span>
      );
    default:
      return null;
  }
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const text =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return <span className="font-mono text-[12px] tabular-nums">{text}</span>;
}

function WorkingLine({ run }: { run: RunView }) {
  const { status, waitingFor } = run.timeline;
  if (status === "waiting") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-waiting">
        <span className="size-2 rounded-full bg-waiting" />
        {waitingFor === "takeover" ? "Waiting for you to take over" : "Waiting for your approval"}
      </div>
    );
  }
  const label =
    status === "queued" ? "Up next" : status === "starting" ? "Getting ready" : "Working";
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "queued" ? "bg-muted-foreground/50" : "animate-tally bg-live",
        )}
      />
      <span>{label}</span>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </div>
  );
}

function renderItem(item: TimelineItem, botId: string, bot: BotSummary | undefined) {
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
      return <CommandStep item={item} />;
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
}: {
  run: RunView;
  chatId: string;
  bot: BotSummary | undefined;
  bots: BotSummary[];
  /** The same bot ran again after this, so there's nothing to retry. */
  superseded?: boolean;
}) {
  const active = isRunActive(run.timeline.status);
  const items = run.timeline.items;
  const segments = useMemo(() => segment(items), [items]);
  const stepCount = items.filter((item) => !isPinned(item)).length;
  const collapsible = !active && stepCount > 3;
  const [expanded, setExpanded] = useState(false);
  const showSteps = !collapsible || expanded;
  const name = bot?.name ?? "Former teammate";
  const reply = replyText(run);

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
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex h-6 items-center gap-2 text-[13px]">
          <span className="font-heading text-[14.5px] font-semibold">{name}</span>
          <TriggerLabel run={run} bots={bots} />
          {run.authMode === "api_key" && (
            <span className="flex items-center gap-1 rounded-full bg-subtle px-2 py-px text-[11.5px] text-muted-foreground">
              <KeyRound className="size-3" />
              API key
            </span>
          )}
          <RunTime run={run} />
          {!active && reply && (
            <span className="flex items-center">
              <CopyReply text={reply} />
              <ReadAloud runId={run.id} text={reply} />
              {run.timeline.status === "completed" && bot && (
                <ReplyFeedback run={run} botName={name} chatId={chatId} />
              )}
            </span>
          )}
        </header>

        {collapsible && (
          <button
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 self-start rounded-md text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={expanded}
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
            />
            {expanded ? "Hide" : "Show"} {stepCount} {stepCount === 1 ? "step" : "steps"}
          </button>
        )}

        <div className="flex flex-col gap-1.5">
          {segments.map((part) => {
            if (part.kind === "desktop") {
              return showSteps ? (
                <div key={part.id} className="my-1">
                  <DesktopStrip items={part.items} live={active} />
                </div>
              ) : null;
            }
            if (!showSteps && !isPinned(part.item)) return null;
            const content = renderItem(part.item, run.botId, bot);
            if (!content) return null;
            const spaced =
              part.item.kind === "message" ||
              part.item.kind === "approval" ||
              part.item.kind === "takeover_request" ||
              part.item.kind === "plan" ||
              part.item.kind === "swarm" ||
              part.item.kind === "user_message";
            return (
              <div key={part.id} className={cn(spaced && "my-1")}>
                {content}
              </div>
            );
          })}
        </div>

        {active && <WorkingLine run={run} />}
        <RunMemory runId={run.id} />
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
      </div>
    </article>
  );
}
