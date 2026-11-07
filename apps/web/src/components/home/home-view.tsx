"use client";

import { BOT_COLORS, isRunActive, TEAMMATE_TEMPLATES } from "@open-bot/shared";
import { format, formatDistanceToNowStrict, isToday, isTomorrow } from "date-fns";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CalendarDays,
  Eye,
  Mail,
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
import { ComputerPanel, useComputer } from "@/components/computer/computer-panel";
import { Briefing } from "@/components/home/briefing";
import { PageThumbnail } from "@/components/pages/page-thumbnail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity, useAppState, usePages, useProfile, useSchedules } from "@/lib/client/queries";
import {
  botActivity,
  botNeedsText,
  botSubtitle,
  isComputerOnline,
  PAUSED_OFFLINE,
} from "@/lib/status";
import type { AppState } from "@/lib/types";
import { chatHref, cn, plainText } from "@/lib/utils";

/** The minute it is in the browser. Null while rendering on the server, whose clock and time zone aren't the reader's. */
function subscribeMinute(onChange: () => void) {
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}
function useMinute(): number | null {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
}

function greeting(name: string, now: Date) {
  const hour = now.getHours();
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

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The line under the greeting, from the real state: how many things need you (each take over
 * request and each approval), then whether work is moving. While the computer is offline nothing
 * moves, and the line says so rather than counting anyone as working.
 */
export function teamSummary(
  state: Pick<AppState, "bots" | "computer" | "pendingApprovals" | "takeoverRequests">,
): string {
  const online = isComputerOnline(state);
  const things = state.takeoverRequests.length + state.pendingApprovals;
  const needs = things > 0 ? `${count(things, "thing needs", "things need")} you` : null;
  if (!online) {
    const busy = state.bots.some((bot) => bot.activeRun);
    const paused = busy
      ? "Work is paused until the computer is back."
      : "Your teammates pick up again when the computer is back.";
    return needs ? `${needs}. ${paused}` : paused;
  }
  const working = state.bots.filter((bot) => botActivity(bot) === "working").length;
  if (needs && working)
    return `${needs}, and ${count(working, "teammate is", "teammates are")} working.`;
  if (needs) return `${needs}.`;
  if (working) return `${count(working, "teammate is", "teammates are")} working right now.`;
  return "Your teammates are ready when you are.";
}

function NeedsYou() {
  const { data: state } = useAppState();
  if (!state) return null;
  const online = isComputerOnline(state);
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
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Needs you
      </h2>
      <div className="flex flex-col gap-2">
        {requests.map((request) => (
          <Link
            key={request.id}
            href={`/computer?screen=${request.screenId}`}
            className="flex items-center gap-3 rounded-xl border border-attention/40 bg-attention/[0.07] px-4 py-3 transition-colors hover:bg-attention/[0.12]"
            data-testid="home-takeover-request"
          >
            <Hand className="size-4 shrink-0 text-attention-ink" />
            <span className="flex min-w-0 flex-1 flex-col gap-1 text-[14px]">
              <span>
                <span className="font-medium">{request.botName} needs you to take over:</span>{" "}
                <span className="text-muted-foreground">{request.reason}</span>
              </span>
              {!online && (
                <span className="text-[13px] text-attention-ink">
                  You can take over once the computer is back.
                </span>
              )}
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
        {state.pendingApprovals > 0 && (
          <Link
            href="/approvals"
            className="flex items-center gap-3 rounded-xl border border-attention/40 bg-attention/[0.07] px-4 py-3 transition-colors hover:bg-attention/[0.12]"
          >
            <ShieldAlert className="size-4 shrink-0 text-attention-ink" />
            <span className="flex-1 text-[14px] font-medium">
              {state.pendingApprovals === 1
                ? "1 action needs your approval"
                : `${state.pendingApprovals} actions need your approval`}
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
        )}
        {proposals.map((proposal) => (
          <Link
            key={proposal.id}
            href={`/bots/${proposal.bot.id}`}
            className="flex items-center gap-3 rounded-xl bg-card shadow-raised px-4 py-3 transition-colors hover:bg-muted/40"
            data-testid="proposal-link"
          >
            <Sparkles className="size-4 shrink-0 text-muted-foreground" />
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
    <div className="relative flex items-center gap-3.5 rounded-xl bg-card px-4 py-3.5 shadow-raised">
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

/**
 * Your teammates. On a wide screen the sidebar already lists them, so Home only shows them there
 * to help you create the first one.
 */
function Teammates() {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const online = isComputerOnline(state);
  return (
    <section
      className={cn("flex flex-col gap-3", bots.length > 0 && "lg:hidden")}
      aria-label="Teammates"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
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
            {TEAMMATE_TEMPLATES.slice(0, 3).map((template, index) => (
              <BotAvatar
                key={template.id}
                name={template.name}
                emoji={template.emoji}
                color={BOT_COLORS[index * 2]}
                size="md"
                className="rounded-[10px] ring-4 ring-card"
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
        <div className="grid gap-2 sm:grid-cols-2">
          {bots.map((bot) => {
            const activity = botActivity(bot, online);
            return (
              <Link
                key={bot.id}
                href={bot.directChatId ? `/chats/${bot.directChatId}` : `/bots/${bot.id}`}
                className="group flex min-w-0 items-center gap-3 rounded-xl bg-card px-3 py-2.5 shadow-raised transition-shadow hover:shadow-float"
                data-testid="teammate-card"
              >
                <BotAvatar
                  name={bot.name}
                  color={bot.color}
                  emoji={bot.emoji}
                  size="md"
                  activity={activity}
                  className="[--avatar-ring:var(--card)]"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-semibold">{bot.name}</span>
                    {bot.isPrimary && (
                      <span className="rounded-full bg-subtle px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                        Lead
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12.5px] text-muted-foreground",
                      botNeedsText(bot) && "text-attention-ink",
                    )}
                  >
                    {botSubtitle(bot, online)}
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

/** "Today 4:00 PM", "Tomorrow 8:00 AM", or "Mon 8:00 AM" further out. */
function nextRunLabel(date: Date): string {
  const time = format(date, "h:mm a");
  if (isToday(date)) return `Today ${time}`;
  if (isTomorrow(date)) return `Tomorrow ${time}`;
  return format(date, "EEE h:mm a");
}

function SideHeading({ title, href, label }: { title: string; href: string; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </h2>
      <Link
        href={href}
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

/** The next few scheduled runs, so you know what your teammates will do without asking. */
function ComingUp() {
  const { data: state } = useAppState();
  const { data: schedules } = useSchedules();
  const online = isComputerOnline(state);
  const next = (schedules ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, 3);
  if (!state || next.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Coming up" data-testid="coming-up">
      <SideHeading title="Coming up" href="/automations" label="Automations" />
      <ol className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-raised">
        {next.map((schedule) => {
          const bot = state.bots.find((entry) => entry.id === schedule.botId);
          return (
            <li key={schedule.id} className="flex items-center gap-3 px-3.5 py-2.5">
              {bot ? (
                <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="sm" />
              ) : (
                <span className="size-7 shrink-0 rounded-[8px] bg-subtle" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-medium">{schedule.title}</span>
                <span className="truncate text-[12.5px] text-muted-foreground">
                  {bot?.name ?? "Former teammate"}
                </span>
              </span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
                {nextRunLabel(new Date(schedule.nextRunAt!))}
              </span>
            </li>
          );
        })}
      </ol>
      {!online && (
        <p className="px-1 text-[12.5px] text-muted-foreground">
          These wait while the computer is offline.
        </p>
      )}
    </section>
  );
}

/** The latest pages your teammates published, as pictures you can open. */
function RecentPages() {
  const { data: state } = useAppState();
  const { data: pages } = usePages();
  const latest = [...(pages ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 2);
  if (!state || latest.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Recent pages" data-testid="recent-pages">
      <SideHeading title="Recent pages" href="/pages" label="All pages" />
      <div className="grid grid-cols-2 gap-3">
        {latest.map((page) => {
          const bot = state.bots.find((entry) => entry.id === page.botId);
          return (
            <Link
              key={page.id}
              href={`/pages/${page.id}`}
              className="group flex min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised transition-shadow hover:shadow-float"
            >
              <PageThumbnail versionId={page.versionId} />
              <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                <span className="truncate text-[13.5px] font-medium group-hover:underline">
                  {page.title}
                </span>
                <span className="truncate text-[12.5px] text-muted-foreground">
                  {bot?.name ?? "Former teammate"} ·{" "}
                  {formatDistanceToNowStrict(new Date(page.updatedAt), { addSuffix: true })}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Activity() {
  const { data: state } = useAppState();
  const { data, isLoading } = useActivity();
  const online = isComputerOnline(state);
  if (!state || state.bots.length === 0) return null;
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
            const active = isRunActive(item.status);
            const paused = active && !online && item.status !== "waiting";
            return (
              <li key={item.runId}>
                <Link
                  href={chatHref(item.chatId, item.runId)}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-subtle/70"
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
                    <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
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
                      {item.trigger === "gmail" && (
                        <span className="flex items-center gap-1">
                          <Mail className="size-3" /> new mail
                        </span>
                      )}
                      {item.trigger === "calendar" && (
                        <span className="flex items-center gap-1">
                          <CalendarDays className="size-3" /> event coming up
                        </span>
                      )}
                      <span>
                        · {formatDistanceToNowStrict(new Date(item.createdAt), { addSuffix: true })}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[13.5px] leading-snug text-foreground/90">
                      {active ? (
                        <span
                          className={cn(
                            "flex items-center gap-1.5 text-muted-foreground",
                            item.status === "waiting" && "text-attention-ink",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              item.status === "waiting"
                                ? "bg-attention"
                                : item.status === "queued" || paused
                                  ? "bg-idle"
                                  : "animate-tally bg-working",
                            )}
                          />
                          {item.status === "waiting"
                            ? "Needs you"
                            : paused
                              ? PAUSED_OFFLINE
                              : item.status === "queued"
                                ? "Up next"
                                : "Working on it"}
                        </span>
                      ) : item.status === "failed" ? (
                        <>
                          <AlertCircle className="mr-1.5 inline size-3.5 -translate-y-px text-destructive" />
                          {plainText(item.preview ?? "Couldn't finish")}
                        </>
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
  const { online } = useComputer();
  // While the computer is offline it is one short card, so its column narrows.
  const offline = Boolean(state) && !online;
  const minute = useMinute();
  const now = minute === null ? null : new Date(minute * 60_000);
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto grid w-full max-w-[1400px] gap-10 px-5 py-8 sm:px-10 sm:py-12 xl:gap-12",
          offline
            ? "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
            : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-1.5">
            <p className="h-[18px] text-[13px] font-medium text-muted-foreground">
              {now && format(now, "EEEE, MMMM d")}
            </p>
            <h1 className="text-[30px] leading-tight font-semibold">
              {now && state ? (
                greeting(state.user.name, now)
              ) : (
                // Holds the line's height until the browser knows what time it is.
                <span className="invisible">Welcome</span>
              )}
            </h1>
            <p className="h-[22px] text-[14.5px] text-muted-foreground">
              {state && teamSummary(state)}
            </p>
          </div>
          <NeedsYou />
          <Briefing />
          <ProfileNudge />
          <Teammates />
          <Activity />
        </div>
        <div className="flex min-w-0 flex-col gap-8 xl:self-start">
          {/* Takeover requests are already in "Needs you", so the panel leaves them out. */}
          <ComputerPanel botIds={state?.bots.map((bot) => bot.id) ?? []} showRequests={false} />
          <ComingUp />
          <RecentPages />
        </div>
      </div>
    </div>
  );
}
