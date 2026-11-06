"use client";

import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict, isToday } from "date-fns";
import { AlertCircle, CalendarClock, Eye, History, Webhook, X } from "lucide-react";
import Link from "next/link";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { getJson } from "@/lib/client/api";
import { dismissBriefing, useBriefingSince } from "@/lib/client/presence";
import { useAppState } from "@/lib/client/queries";
import type { BriefingItem } from "@/lib/types";
import { chatHref, plainText } from "@/lib/utils";

/** The most replies shown for each teammate; the rest are a link away. */
const PER_BOT = 3;

const TRIGGER_ICONS = { schedule: CalendarClock, watch: Eye, webhook: Webhook } as const;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** A time on the clock the rest of the app uses: "7:38 AM", or "Thu 7:38 AM" before today. */
function clock(date: Date) {
  return format(date, isToday(date) ? "h:mm a" : "EEE h:mm a");
}

function Item({ item }: { item: BriefingItem }) {
  const Icon =
    item.trigger in TRIGGER_ICONS
      ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
      : null;
  return (
    <li>
      <Link
        href={chatHref(item.chatId, item.runId)}
        className="group flex items-baseline gap-2 rounded-md py-1 text-[13.5px] leading-snug"
      >
        {Icon ? (
          <Icon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate group-hover:underline">
          {item.automationTitle && <span className="font-medium">{item.automationTitle}: </span>}
          {plainText(item.preview ?? "Done")}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
          {clock(new Date(item.completedAt))}
        </span>
      </Link>
    </li>
  );
}

/** Something that didn't finish: first in the list, with why and a way to look at it. */
function Failure({ item, botName }: { item: BriefingItem; botName: string }) {
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
        <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-foreground/85">
          {plainText(item.preview ?? "It stopped before it was done.")}
        </span>
      </div>
      <Button variant="outline" size="sm" className="shrink-0 self-center" asChild>
        <Link href={chatHref(item.chatId, item.runId)}>Review</Link>
      </Button>
    </li>
  );
}

const newestFirst = (a: BriefingItem, b: BriefingItem) =>
  b.completedAt.localeCompare(a.completedAt);

/** What your teammates finished while you were away: what failed first, then by teammate, newest first. */
export function Briefing() {
  const since = useBriefingSince();
  const { data: state } = useAppState();
  const { data: items } = useQuery({
    queryKey: ["briefing", since],
    queryFn: () => getJson<BriefingItem[]>(`/api/briefing?since=${since}`),
    enabled: since !== null,
  });
  if (!since || !state || !items?.length) return null;

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
            {summary} since {clock(sinceDate)}, {formatDistanceToNowStrict(sinceDate)} ago.
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
            <Failure key={item.runId} item={item} botName={botName(item.botId)} />
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
                      className="self-start py-1 pl-5.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:underline"
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
