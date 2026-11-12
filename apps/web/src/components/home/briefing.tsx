"use client";

import { plural } from "@open-bot/chat-core";
import { format, formatDistanceToNowStrict, isToday } from "date-fns";
import { AlertCircle, CalendarClock, Eye, History, RotateCcw, Webhook, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import { dismissBriefing, useBriefingSince } from "@/lib/client/presence";
import { useAppState, useHome } from "@/lib/client/queries";
import { failureLine, isComputerOnline } from "@/lib/status";
import type { BriefingItem } from "@/lib/types";
import { chatHref, cn, plainText } from "@/lib/utils";

/** The most replies shown for each teammate; the rest are a link away. */
const PER_BOT = 3;

const TRIGGER_ICONS = { schedule: CalendarClock, watch: Eye, webhook: Webhook } as const;

/** A time on the clock the rest of the app uses: "7:38 AM", or "Thu 7:38 AM" before today. */
function clock(date: Date) {
  return format(date, isToday(date) ? "h:mm a" : "EEE h:mm a");
}

/** Where every time in the briefing ends, so a failure's time lines up with the replies'. */
const TIME_INSET = "sm:pr-3";

function Item({ item }: { item: BriefingItem }) {
  const Icon =
    item.trigger in TRIGGER_ICONS
      ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
      : null;
  return (
    <li>
      <Link
        href={chatHref(item.chatId, item.runId)}
        className={cn(
          "group flex items-baseline gap-2 rounded-md py-1 text-[13.5px] leading-snug",
          TIME_INSET,
        )}
        data-testid="briefing-item"
      >
        {/*
          Two lines, so the outcome at the end of a reply survives. On a narrow screen the time
          goes under the line instead of taking width from it. The text starts under the name;
          a scheduled or triggered reply says so with a small icon in its first line.
        */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 group-hover:underline">
            {Icon && (
              <Icon className="mr-1.5 inline size-3.5 -translate-y-px text-muted-foreground" />
            )}
            {item.automationTitle && <span className="font-medium">{item.automationTitle}: </span>}
            {plainText(item.preview ?? "Done")}
          </span>
          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
            {clock(new Date(item.completedAt))}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Runs the request again and opens its chat to follow along. */
function RetryButton({ item }: { item: BriefingItem }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      disabled={retrying}
      data-testid="briefing-retry"
      onClick={() =>
        startRetry(async () => {
          const result = await attempt(api.runs.retry({ runId: item.runId }));
          if (!result.ok) {
            toast.error("Couldn't try again", { description: result.error });
            return;
          }
          router.push(chatHref(item.chatId));
        })
      }
    >
      <RotateCcw className={cn(retrying && "animate-spin")} />
      Retry
    </Button>
  );
}

/**
 * Something that didn't finish: first in the list, with what happened as it stands now and a way to
 * run it again. While the computer is offline a retry can't start, so the row says so and opens the chat.
 */
function Failure({
  item,
  botName,
  computerOnline,
}: {
  item: BriefingItem;
  botName: string;
  computerOnline: boolean;
}) {
  return (
    <li
      className="flex items-start gap-3 rounded-lg bg-subtle px-3 py-2.5 dark:bg-white/[0.03]"
      data-testid="briefing-failure"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
          <span className="min-w-0 flex-1 truncate font-medium">
            {botName} couldn&apos;t finish
          </span>
          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
            {clock(new Date(item.completedAt))}
          </span>
        </span>
        <span className="truncate text-[12.5px] text-muted-foreground">
          {item.automationTitle ?? item.chatTitle}
        </span>
        <span className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-pretty text-foreground/85">
          {failureLine(item.preview && plainText(item.preview))}
          {!computerOnline && (
            <span className="text-muted-foreground"> You can retry once the computer is back.</span>
          )}
        </span>
        {/* The action sits under the text, so the time stays in line with every other time. */}
        <div className="mt-2">
          {computerOnline ? (
            <RetryButton item={item} />
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href={chatHref(item.chatId, item.runId)}>Open chat</Link>
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

const newestFirst = (a: BriefingItem, b: BriefingItem) =>
  b.completedAt.localeCompare(a.completedAt);

/** What finished while you were away, or nothing when the briefing isn't showing. */
export function useBriefingItems(): BriefingItem[] {
  const since = useBriefingSince();
  const { data: home, isPlaceholderData } = useHome(since);
  return since !== null && home && !isPlaceholderData ? home.briefing : [];
}

/** What your teammates finished while you were away: what failed first, then by teammate, newest first. */
export function Briefing() {
  const since = useBriefingSince();
  const { data: state } = useAppState();
  const computerOnline = isComputerOnline(state);
  const items = useBriefingItems();
  if (!since || !state || !items.length) return null;

  const failures = items.filter((item) => item.status === "failed").sort(newestFirst);
  const finished = items.filter((item) => item.status !== "failed").sort(newestFirst);
  // Teammates in the order of their latest work, since the items are newest first.
  const byBot = new Map<string, BriefingItem[]>();
  for (const item of finished) byBot.set(item.botId, [...(byBot.get(item.botId) ?? []), item]);
  const botName = (botId: string) =>
    state.bots.find((entry) => entry.id === botId)?.name ?? "A former teammate";
  const sinceDate = new Date(since);
  const summary = [
    finished.length > 0 && `${plural(finished.length, "task")} done`,
    failures.length > 0 && `${failures.length} didn't finish`,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <section
      className="flex flex-col gap-4 rounded-xl bg-card px-4 pt-3.5 pb-3 shadow-raised"
      aria-label="While you were away"
      data-testid="briefing"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
          <History className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-[14px] font-medium">While you were away</h2>
          <p className="text-[13px] text-muted-foreground">
            {summary} since {clock(sinceDate)}
            {/* On a phone the clock time is enough. */}
            <span className="max-sm:hidden">, {formatDistanceToNowStrict(sinceDate)} ago</span>.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss the briefing"
          className="-mt-0.5 -mr-1 text-muted-foreground"
          onClick={dismissBriefing}
        >
          <X />
        </Button>
      </div>
      {failures.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {failures.map((item) => (
            <Failure
              key={item.runId}
              item={item}
              botName={botName(item.botId)}
              computerOnline={computerOnline}
            />
          ))}
        </ul>
      )}
      {byBot.size > 0 && (
        <ul className="flex flex-col gap-3">
          {[...byBot.entries()].map(([botId, botItems]) => {
            const bot = state.bots.find((entry) => entry.id === botId);
            const extra = botItems.length - PER_BOT;
            return (
              <li key={botId} className="flex gap-3" data-testid="briefing-bot">
                {bot ? (
                  <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="sm" />
                ) : (
                  <span className="size-7 shrink-0 rounded-[8px] bg-subtle" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex h-7 items-center gap-1.5 text-[13.5px]">
                    <span className="font-medium">{bot?.name ?? "Former teammate"}</span>
                    <span className="text-muted-foreground">
                      · {plural(botItems.length, "task")}
                    </span>
                  </span>
                  <ul className="flex flex-col">
                    {botItems.slice(0, PER_BOT).map((item) => (
                      <Item key={item.runId} item={item} />
                    ))}
                  </ul>
                  {extra > 0 && bot && (
                    <Link
                      href={`/bots/${bot.id}?tab=chats`}
                      className="self-start py-1 text-[12.5px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      and {extra} more
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
