"use client";

import { isRunActive } from "@open-bot/domain";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { TimeAgo } from "@/components/time-ago";
import { useBriefingItems } from "./briefing";
import { useBriefingSince } from "@/lib/client/presence";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppState } from "@/features/app-shell";
import { useHome } from "../hooks";
import { failureLine, isComputerOnline, STATUS } from "@/lib/status";
import type { ActivityView } from "@/lib/types";
import { chatHref, cn, plainText } from "@/lib/utils";
import { ACTIVITY_TRIGGER_ICONS } from "./recent-pages";

/**
 * What came of a teammate's turn, in a few words for one line: its status while it is still going
 * (in the words used everywhere), else the start of the reply, or why it didn't finish.
 */
function activityOutcome(
  item: ActivityView,
  online: boolean,
  waitingFor: "approval" | "takeover" | null,
): { text: string; tone: "attention" | "failed" | "plain"; dot: string | null; where?: string } {
  // While it's going, the status alone doesn't say what it's about: the chat's name does.
  const where =
    item.chatKind === "direct" || item.chatKind === "group" ? item.chatTitle : undefined;
  if (isRunActive(item.status)) {
    if (item.status === "waiting") {
      return {
        text: waitingFor === "takeover" ? STATUS.takeover : STATUS.approval,
        tone: "attention",
        dot: "bg-attention",
        where,
      };
    }
    if (!online) return { text: STATUS.paused, tone: "plain", dot: "bg-idle", where };
    if (item.status === "queued")
      return { text: STATUS.upNext, tone: "plain", dot: "bg-idle", where };
    return { text: STATUS.working, tone: "plain", dot: "animate-tally bg-working", where };
  }
  if (item.status === "failed")
    return {
      text: failureLine(item.preview && plainText(item.preview)),
      tone: "failed",
      dot: null,
    };
  const text = plainText(item.preview ?? (item.status === "interrupted" ? "Stopped" : "Done"));
  const group = item.chatKind === "group" ? `${item.chatTitle}: ` : "";
  return { text: `${group}${text}`, tone: "plain", dot: null };
}

export function Activity() {
  const { data: state } = useAppState();
  const since = useBriefingSince();
  const { data: home, isLoading } = useHome(since);
  const all = home?.activity;
  const briefed = useBriefingItems();
  const online = isComputerOnline(state);
  // What the briefing above already tells you isn't repeated here.
  const data = useMemo(() => {
    const shown = new Set(briefed.map((item) => item.runId));
    return all?.filter((item) => !shown.has(item.runId));
  }, [all, briefed]);
  if (!state || state.bots.length === 0) return null;
  if (briefed.length > 0 && !isLoading && !data?.length) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Recent activity">
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Recent activity
      </h2>
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : !data?.length ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[14px] text-muted-foreground">
          Nothing yet. Message a teammate to get them working.
        </p>
      ) : (
        <ol className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-raised">
          {data.map((item) => {
            const bot = state.bots.find((b) => b.id === item.botId);
            const outcome = activityOutcome(
              item,
              online,
              state.bots.find((entry) => entry.activeRun?.id === item.runId)?.activeRun
                ?.waitingFor ?? null,
            );
            const TriggerIcon = ACTIVITY_TRIGGER_ICONS[item.trigger];
            return (
              <li key={item.runId}>
                {/* One line: who, what came of it, when. */}
                <Link
                  href={chatHref(item.chatId, item.runId)}
                  className="flex h-12 items-center gap-3 px-3.5 text-[13.5px] transition-colors hover:bg-subtle/70"
                  data-testid="activity-row"
                >
                  {bot ? (
                    <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="sm" />
                  ) : (
                    <span className="size-7 shrink-0 rounded-[8px] bg-subtle" />
                  )}
                  <span className="shrink-0 font-medium">{bot?.name ?? "Former teammate"}</span>
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground",
                      outcome.tone === "attention" && "text-attention-ink",
                    )}
                  >
                    {outcome.dot && (
                      <span className={cn("size-1.5 shrink-0 rounded-full", outcome.dot)} />
                    )}
                    {outcome.tone === "failed" && (
                      <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                    )}
                    {TriggerIcon && !outcome.dot && (
                      <TriggerIcon className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className={outcome.where ? "shrink-0" : "truncate"}>{outcome.text}</span>
                    {outcome.where && (
                      <span className="min-w-0 truncate text-muted-foreground">
                        · {outcome.where}
                      </span>
                    )}
                  </span>
                  <TimeAgo
                    date={item.createdAt}
                    className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums"
                  />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
