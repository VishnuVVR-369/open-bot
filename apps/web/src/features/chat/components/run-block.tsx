"use client";

import { isPinned, replyText, turnParts, workDuration, workSummary } from "@open-bot/chat-core";
import { isNothingToReport, isRunActive, type TimelineItem } from "@open-bot/domain";
import { AlertTriangle, ChevronDown, KeyRound, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { TeammateAvatar } from "@/components/teammate-avatar";
import type { TeammateSummary, RunView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageCard } from "@/features/pages";
import { SwarmCard } from "./swarm-card";
import { ScreenStrip } from "./screen-strip";
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
import { CopyReply, MoreActions, RunTime, RetryRun } from "./reply-actions";
import { TriggerLabel } from "./trigger-label";
import { WorkingLine } from "./working-line";

function renderItem(
  item: TimelineItem,
  teammateId: string,
  teammate: TeammateSummary | undefined,
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
      return <ApprovalCard item={item} teammateName={teammate?.name ?? "Your teammate"} />;
    case "takeover_request":
      return (
        <TakeoverRequestCard
          item={item}
          teammateId={teammateId}
          teammateName={teammate?.name ?? "Your teammate"}
        />
      );
    case "handoff":
      return <HandoffStep item={item} />;
    case "user_message":
      return <SteeredMessage item={item} />;
    case "swarm":
      return <SwarmCard item={item} teammateName={teammate?.name ?? "Your teammate"} />;
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
  teammate,
  teammates,
  superseded = false,
  latest = false,
}: {
  run: RunView;
  chatId: string;
  teammate: TeammateSummary | undefined;
  teammates: TeammateSummary[];
  /** The same teammate ran again after this, so there's nothing to retry. */
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
  const name = teammate?.name ?? "Former teammate";
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
      {reply && run.timeline.status === "completed" && teammate && (
        <ReplyFeedback run={run} teammateName={name} chatId={chatId} />
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
          <TeammateAvatar
            name={name}
            color={teammate?.color ?? "#888888"}
            emoji={teammate?.emoji}
            size="xs"
          />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="font-medium text-foreground/80">{name}</span>
          <TriggerLabel run={run} teammates={teammates} />
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
      <TeammateAvatar
        name={name}
        color={teammate?.color ?? "#888888"}
        emoji={teammate?.emoji}
        size="md"
        className="mt-0.5"
      />
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex h-6 items-center gap-2 text-[13px]">
          <span className="text-[14px] font-semibold">{name}</span>
          <TriggerLabel run={run} teammates={teammates} />
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
                  <ScreenStrip items={part.items} live={active} />
                </div>
              ) : null;
            }
            if (!showSteps && !isPinned(part.item)) return null;
            const content = renderItem(
              part.item,
              run.teammateId,
              teammate,
              approved.has(part.item.id),
            );
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
