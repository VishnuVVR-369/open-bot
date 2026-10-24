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
import { chatHref, cn, plainText } from "@/lib/utils";

/** The most replies shown for each teammate; the rest are a link away. */
const PER_BOT = 3;

const TRIGGER_ICONS = { schedule: CalendarClock, watch: Eye, webhook: Webhook } as const;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function Item({ item }: { item: BriefingItem }) {
  const Icon =
    item.status === "failed"
      ? AlertCircle
      : item.trigger in TRIGGER_ICONS
        ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
        : null;
  const text = plainText(item.preview ?? (item.status === "failed" ? "Failed" : "Done"));
  return (
    <li>
      <Link
        href={chatHref(item.chatId, item.runId)}
        className="group flex items-baseline gap-2 rounded-md py-1 text-[13.5px] leading-snug"
      >
        {Icon ? (
          <Icon
            className={cn(
              "size-3.5 shrink-0 translate-y-0.5",
              item.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate group-hover:underline">
          {item.automationTitle && <span className="font-medium">{item.automationTitle}: </span>}
          <span className={cn(item.status === "failed" && "text-destructive")}>{text}</span>
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
          {format(
            new Date(item.completedAt),
            isToday(new Date(item.completedAt)) ? "HH:mm" : "EEE HH:mm",
          )}
        </span>
      </Link>
    </li>
  );
}

/** What your teammates finished while you were away, by teammate. */
export function Briefing() {
  const since = useBriefingSince();
  const { data: state } = useAppState();
  const { data: items } = useQuery({
    queryKey: ["briefing", since],
    queryFn: () => getJson<BriefingItem[]>(`/api/briefing?since=${since}`),
    enabled: since !== null,
  });
  if (!since || !state || !items?.length) return null;

  const byBot = new Map<string, BriefingItem[]>();
  // Newest first, but what failed comes before what went fine.
  const ordered = [...items].sort(
    (a, b) => Number(b.status === "failed") - Number(a.status === "failed"),
  );
  for (const item of ordered) byBot.set(item.botId, [...(byBot.get(item.botId) ?? []), item]);
  const failed = items.filter((item) => item.status === "failed").length;
  const done = items.length - failed;
  const sinceDate = new Date(since);

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border bg-card px-4 pt-3.5 pb-3"
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
            {[done > 0 && `${plural(done, "task")} done`, failed > 0 && `${failed} failed`]
              .filter(Boolean)
              .join(", ")}{" "}
            since {isToday(sinceDate) ? format(sinceDate, "HH:mm") : format(sinceDate, "EEE HH:mm")}
            , {formatDistanceToNowStrict(sinceDate)} ago.
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
                  <span className="text-muted-foreground">· {plural(botItems.length, "task")}</span>
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
    </section>
  );
}
