"use client";

import { isRunActive } from "@open-bot/shared";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ArrowRight,
  CalendarClock,
  Eye,
  Hand,
  Plus,
  ShieldAlert,
  Sparkles,
  UserRound,
  Users,
  Webhook,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ComputerPanel } from "@/components/computer/computer-panel";
import { Briefing } from "@/components/home/briefing";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity, useAppState, useProfile } from "@/lib/client/queries";
import { botActivity, botStatusText } from "@/lib/status";
import { chatHref, cn, plainText } from "@/lib/utils";

function greeting(name: string) {
  const hour = new Date().getHours();
  const part =
    hour < 5
      ? "Good night"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  return `${part}, ${name.split(" ")[0]}`;
}

function NeedsYou() {
  const { data: state } = useAppState();
  if (!state) return null;
  const waiting = state.bots.filter((bot) => bot.activeRun?.status === "waiting");
  const requests = state.takeoverRequests;
  const proposals = state.proposals.flatMap((proposal) => {
    const bot = state.bots.find((entry) => entry.id === proposal.botId);
    return bot ? [{ ...proposal, bot }] : [];
  });
  if (
    state.pendingApprovals === 0 &&
    requests.length === 0 &&
    waiting.length === 0 &&
    proposals.length === 0
  )
    return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="Needs you">
      <h2 className="text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
        Needs you
      </h2>
      <div className="flex flex-col gap-2">
        {requests.map((request) => (
          <Link
            key={request.id}
            href={`/computer?screen=${request.screenId}`}
            className="flex items-center gap-3 rounded-xl border border-manual/40 bg-manual/[0.07] px-4 py-3 transition-colors hover:bg-manual/[0.12]"
          >
            <Hand className="size-4 shrink-0 text-manual-ink" />
            <span className="min-w-0 flex-1 text-[14px]">
              <span className="font-medium">{request.botName} needs you to take over:</span>{" "}
              <span className="text-muted-foreground">{request.reason}</span>
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
        {state.pendingApprovals > 0 && (
          <Link
            href="/approvals"
            className="flex items-center gap-3 rounded-xl border border-waiting/35 bg-waiting/[0.06] px-4 py-3 transition-colors hover:bg-waiting/[0.1]"
          >
            <ShieldAlert className="size-4 shrink-0 text-waiting" />
            <span className="flex-1 text-[14px] font-medium">
              {state.pendingApprovals === 1
                ? "1 action is waiting for your approval"
                : `${state.pendingApprovals} actions are waiting for your approval`}
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        )}
        {proposals.map((proposal) => (
          <Link
            key={proposal.id}
            href={`/bots/${proposal.bot.id}`}
            className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-muted/40"
            data-testid="proposal-link"
          >
            <Sparkles className="size-4 shrink-0 text-waiting" />
            <span className="flex-1 text-[14px] font-medium">
              {proposal.bot.name} suggests new instructions
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}

const NUDGE_KEY = "open-bot:profile-nudge-dismissed";
const nudgeListeners = new Set<() => void>();

function subscribeNudge(listener: () => void) {
  nudgeListeners.add(listener);
  return () => nudgeListeners.delete(listener);
}

/** Until you write a profile: ask for one, so teammates stop asking the same questions. */
function ProfileNudge() {
  const { data: state } = useAppState();
  const { data: profile } = useProfile();
  const dismissed = useSyncExternalStore(
    subscribeNudge,
    () => localStorage.getItem(NUDGE_KEY) === "1",
    () => true,
  );
  if (dismissed || !profile || profile.aboutMe.trim() || !state?.bots.length) return null;
  return (
    <div className="relative flex items-center gap-3.5 rounded-xl border bg-card px-4 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
        <UserRound className="size-4" />
      </span>
      <Link href="/settings#about" className="group flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium group-hover:underline">
          Tell your teammates about you
        </span>
        <span className="text-[13px] text-muted-foreground">
          Where you live, what you eat, how you like to travel. Every teammate reads it.
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="text-muted-foreground"
        onClick={() => {
          localStorage.setItem(NUDGE_KEY, "1");
          for (const listener of nudgeListeners) listener();
        }}
      >
        <X />
      </Button>
    </div>
  );
}

function Teammates() {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  return (
    <section className="flex flex-col gap-3" aria-label="Teammates">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
          Teammates
        </h2>
        {bots.length > 0 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/bots/new">
              <Plus />
              New teammate
            </Link>
          </Button>
        )}
      </div>
      {bots.length === 0 ? (
        <Link
          href="/bots/new"
          className="group flex flex-col gap-4 rounded-2xl border border-dashed bg-card px-6 py-8 transition-colors hover:border-foreground/30"
        >
          <div className="flex -space-x-2">
            {["#7C5CFF", "#14B8A6", "#F97316"].map((color, index) => (
              <BotAvatar
                key={color}
                name={["Iris", "Otto", "Juno"][index]!}
                color={color}
                size="md"
                className="ring-4 ring-card"
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[16px] font-semibold">Create your first teammate</span>
            <span className="max-w-md text-[14px] text-muted-foreground">
              Give them a job, like research, your inbox or shopping. They work on the shared
              computer while you do other things.
            </span>
          </div>
          <span className="flex items-center gap-1.5 text-[14px] font-medium">
            Get started{" "}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {bots.map((bot) => {
            const activity = botActivity(bot);
            return (
              <Link
                key={bot.id}
                href={bot.directChatId ? `/chats/${bot.directChatId}` : `/bots/${bot.id}`}
                className="group flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors hover:border-foreground/20"
                data-testid="teammate-card"
              >
                <BotAvatar
                  name={bot.name}
                  color={bot.color}
                  emoji={bot.emoji}
                  size="lg"
                  activity={activity}
                  className="[&>span:last-child]:ring-card"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold">{bot.name}</span>
                    {bot.isPrimary && (
                      <span className="rounded-full bg-subtle px-1.5 py-px text-[10.5px] text-muted-foreground">
                        lead
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[13px] text-muted-foreground",
                      activity === "waiting" && "text-waiting",
                    )}
                  >
                    {botStatusText(bot)}
                  </span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Activity() {
  const { data: state } = useAppState();
  const { data, isLoading } = useActivity();
  if (!state || state.bots.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Recent activity">
      <h2 className="text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
        Recent activity
      </h2>
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : !data?.length ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[14px] text-muted-foreground">
          Nothing yet. Message a teammate to get them working.
        </p>
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border bg-card">
          {data.map((item) => {
            const bot = state.bots.find((b) => b.id === item.botId);
            const active = isRunActive(item.status);
            return (
              <li key={item.runId}>
                <Link
                  href={chatHref(item.chatId, item.runId)}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  {bot ? (
                    <BotAvatar
                      name={bot.name}
                      color={bot.color}
                      emoji={bot.emoji}
                      size="sm"
                      className="mt-0.5"
                    />
                  ) : (
                    <span className="size-7 rounded-[8px] bg-subtle" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {bot?.name ?? "Former teammate"}
                      </span>
                      {item.chatKind === "group" && (
                        <span className="flex items-center gap-1">
                          <Users className="size-3" /> {item.chatTitle}
                        </span>
                      )}
                      {item.trigger === "schedule" && (
                        <span className="flex items-center gap-1">
                          <CalendarClock className="size-3" /> scheduled
                        </span>
                      )}
                      {item.trigger === "watch" && (
                        <span className="flex items-center gap-1">
                          <Eye className="size-3" /> page changed
                        </span>
                      )}
                      {item.trigger === "webhook" && (
                        <span className="flex items-center gap-1">
                          <Webhook className="size-3" /> webhook
                        </span>
                      )}
                      <span>
                        · {formatDistanceToNowStrict(new Date(item.createdAt), { addSuffix: true })}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "line-clamp-2 text-[14px]",
                        item.status === "failed" && "text-destructive",
                      )}
                    >
                      {active ? (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              item.status === "waiting" ? "bg-waiting" : "animate-tally bg-live",
                            )}
                          />
                          {item.status === "waiting" ? "Waiting for you" : "Working on it"}
                        </span>
                      ) : (
                        plainText(
                          item.preview ?? (item.status === "interrupted" ? "Stopped" : "Done"),
                        )
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function HomeView() {
  const { data: state } = useAppState();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[1400px] gap-10 px-5 py-8 sm:px-8 sm:py-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[28px] leading-tight font-semibold">
              {state ? greeting(state.user.name) : "Welcome"}
            </h1>
            <p className="text-[15px] text-muted-foreground">
              {state?.bots.some((bot) => bot.activeRun && bot.activeRun.status !== "queued")
                ? `${state.bots.filter((bot) => bot.activeRun && bot.activeRun.status !== "queued").length} teammate${state.bots.filter((bot) => bot.activeRun && bot.activeRun.status !== "queued").length === 1 ? " is" : "s are"} working right now.`
                : "Your teammates are ready when you are."}
            </p>
          </div>
          <NeedsYou />
          <Briefing />
          <ProfileNudge />
          <Teammates />
          <Activity />
        </div>
        <div className="min-w-0 xl:sticky xl:top-10 xl:self-start">
          <ComputerPanel botIds={state?.bots.map((bot) => bot.id) ?? []} />
        </div>
      </div>
    </div>
  );
}
