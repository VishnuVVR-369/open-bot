"use client";

import { greeting, plural } from "@open-bot/chat-core";
import { approvalShortTitle, BOT_COLORS, isRunActive, TEAMMATE_TEMPLATES } from "@open-bot/domain";
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
  Webhook,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { TimeAgo } from "@/components/time-ago";
import { ComputerOffline, ComputerPanel, useComputer } from "@/components/computer/computer-panel";
import { Briefing, useBriefingItems } from "@/components/home/briefing";
import { useBriefingSince } from "@/lib/client/presence";
import { PageThumbnail } from "@/components/pages/page-thumbnail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useApprovals,
  useAppState,
  useHome,
  usePages,
  useProfile,
  useSchedules,
} from "@/lib/client/queries";
import {
  botActivity,
  failureLine,
  isComputerOnline,
  runIsHeldBack,
  STATUS,
  teammateStatus,
  WAITING_FOR_COMPUTER,
} from "@/lib/status";
import type { ActivityView, AppState, TakeoverRequestSummary } from "@/lib/types";
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
  const needs = things > 0 ? `${plural(things, "thing needs", "things need")} you` : null;
  if (!online) {
    const busy = state.bots.some((bot) => bot.activeRun);
    const paused = busy
      ? "Work is paused until the computer is back."
      : "Your teammates pick up again when the computer is back.";
    return needs ? `${needs}. ${paused}` : paused;
  }
  const working = state.bots.filter((bot) => botActivity(bot) === "working").length;
  if (needs && working)
    return `${needs}, and ${plural(working, "teammate is", "teammates are")} working.`;
  if (needs) return `${needs}.`;
  if (working) return `${plural(working, "teammate is", "teammates are")} working right now.`;
  return "Your teammates are ready when you are.";
}

/** The amber row of something you can act on. */
const NEEDS_ROW =
  "flex items-start gap-3 rounded-xl border border-attention/40 bg-attention/[0.07] px-4 py-3 transition-colors hover:bg-attention/[0.12]";

/** The most approvals listed one by one; the rest are on the approvals page. */
const APPROVALS_SHOWN = 3;

/** Each pending approval on its own row: what it does, with the amount or recipient, and who asks. */
function ApprovalRows({ state }: { state: AppState }) {
  const { data } = useApprovals();
  const pending = (data ?? []).filter((approval) => approval.status === "pending");
  // Until the list agrees with the count, one row stands for them all.
  if (pending.length !== state.pendingApprovals)
    return (
      <Link href="/approvals" className={NEEDS_ROW} data-testid="home-approvals">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-attention-ink" />
        <span className="flex-1 text-[14px] font-medium">
          {state.pendingApprovals === 1
            ? "1 action needs your approval"
            : `${state.pendingApprovals} actions need your approval`}
        </span>
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </Link>
    );
  const more = pending.length - APPROVALS_SHOWN;
  return (
    <>
      {pending.slice(0, APPROVALS_SHOWN).map((approval) => {
        const bot = state.bots.find((entry) => entry.id === approval.botId);
        const title = approvalShortTitle({
          ...approval,
          previewType: approval.preview?.type ?? null,
        });
        return (
          <Link
            key={approval.id}
            href={chatHref(approval.chatId, approval.runId)}
            className={NEEDS_ROW}
            data-testid="home-approval"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-attention-ink" />
            <span className="line-clamp-2 min-w-0 flex-1 text-[14px] break-words text-pretty">
              <span className="font-medium">{title}</span>
              {bot && <span className="text-muted-foreground"> · {bot.name}</span>}
            </span>
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          </Link>
        );
      })}
      {more > 0 && (
        <Link
          href="/approvals"
          className="flex items-center gap-1 self-start px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {more} more {more === 1 ? "approval" : "approvals"}
          <ArrowRight className="size-3.5" />
        </Link>
      )}
    </>
  );
}

/**
 * A teammate asks you to take over their screen. While the computer is online you can, so it is
 * an amber row like an approval. While it is offline you can't yet: a lighter card with when you
 * can, after what you can act on now.
 */
function TakeoverRow({ request, online }: { request: TakeoverRequestSummary; online: boolean }) {
  const href = `/computer?screen=${request.screenId}`;
  if (online)
    return (
      <Link href={href} className={NEEDS_ROW} data-testid="home-takeover-request">
        <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
        <span className="line-clamp-2 min-w-0 flex-1 text-[14px] break-words text-pretty">
          <span className="font-medium">{request.botName} needs you to take over:</span>{" "}
          <span className="text-muted-foreground">{request.reason}</span>
        </span>
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </Link>
    );
  return (
    <div
      className="flex items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-raised"
      data-testid="home-takeover-request"
    >
      <Hand className="mt-0.5 size-4 shrink-0 text-attention-ink" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium">{request.botName} needs you to take over</span>
        <span className="line-clamp-2 text-[13px] break-words text-pretty text-muted-foreground">
          {request.reason}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[12.5px] text-muted-foreground">
            You can take over once the computer is back.
          </span>
          <Link
            href={href}
            className="flex items-center gap-1 text-[13px] font-medium text-foreground/85 transition-colors hover:text-foreground"
          >
            View request
            <ArrowRight className="size-3.5" />
          </Link>
        </span>
      </div>
    </div>
  );
}

/**
 * What needs you, and only what you can act on here: each approval, then each take over request
 * (first instead while the computer is online, since then it's the most urgent). The number in the
 * line under the greeting counts exactly these rows.
 */
function NeedsYou() {
  const { data: state } = useAppState();
  if (!state) return null;
  const online = isComputerOnline(state);
  const requests = state.takeoverRequests;
  if (state.pendingApprovals === 0 && requests.length === 0) return null;
  const approvals = state.pendingApprovals > 0 && <ApprovalRows state={state} />;
  const takeovers = requests.map((request) => (
    <TakeoverRow key={request.id} request={request} online={online} />
  ));
  return (
    <section className="flex flex-col gap-2.5" aria-label="Needs you">
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        Needs you
      </h2>
      <div className="flex flex-col gap-2">
        {online ? (
          <>
            {takeovers}
            {approvals}
          </>
        ) : (
          <>
            {approvals}
            {takeovers}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A teammate's suggested new instructions: worth a look when you have a minute, so a quiet row
 * outside "Needs you", and not in its count.
 */
function Suggestions() {
  const { data: state } = useAppState();
  const proposals = (state?.proposals ?? []).flatMap((proposal) => {
    const bot = state?.bots.find((entry) => entry.id === proposal.botId);
    return bot ? [{ ...proposal, bot }] : [];
  });
  if (proposals.length === 0) return null;
  return (
    <div className="flex flex-col">
      {proposals.map((proposal) => (
        <Link
          key={proposal.id}
          href={`/bots/${proposal.bot.id}`}
          className="group flex items-center gap-3 rounded-xl px-4 py-2.5 text-[13.5px] transition-colors hover:bg-subtle"
          data-testid="proposal-link"
        >
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 rounded-full bg-subtle px-2 py-px text-[11.5px] font-medium text-muted-foreground group-hover:bg-muted">
            Suggestion
          </span>
          <span className="min-w-0 flex-1 text-pretty">
            {proposal.bot.name} suggests new instructions
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
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
                color={BOT_COLORS[index * 2]!}
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
            const status = teammateStatus(bot, online);
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
                  activity={status.activity}
                  className="[--avatar-ring:var(--card)]"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-[14px] font-semibold">{bot.name}</span>
                    {/* Their job, where there is room; the line below is only their status. */}
                    <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                      {bot.role}
                    </span>
                    {bot.isPrimary && (
                      <span className="shrink-0 self-center rounded-full bg-subtle px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                        Lead
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12.5px] text-muted-foreground",
                      status.needsYou && "text-attention-ink",
                    )}
                  >
                    {status.label}
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
function ComingUp({ now }: { now: number | null }) {
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
                {now !== null && runIsHeldBack(schedule.nextRunAt!, now, online)
                  ? WAITING_FOR_COMPUTER
                  : nextRunLabel(new Date(schedule.nextRunAt!))}
              </span>
            </li>
          );
        })}
      </ol>
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
              {/* A title may take two lines; the byline sits at the bottom, level with its neighbor's. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5">
                <span className="line-clamp-2 text-[13.5px] leading-snug font-medium text-pretty group-hover:underline">
                  {page.title}
                </span>
                <span className="mt-auto truncate text-[12.5px] text-muted-foreground">
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

/** A small mark for a run an automation started, before its outcome. */
const ACTIVITY_TRIGGER_ICONS: Partial<Record<ActivityView["trigger"], typeof CalendarClock>> = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
};

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

function Activity() {
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

export function HomeView() {
  const { data: state } = useAppState();
  const { online } = useComputer();
  // While the computer is offline it is one short card, so its column narrows.
  const offline = Boolean(state) && !online;
  const minute = useMinute();
  const now = minute === null ? null : new Date(minute * 60_000);
  const botIds = state?.bots.map((bot) => bot.id) ?? [];
  const botNames = state?.bots.map((bot) => bot.name) ?? [];
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
                greeting(state.user.name, now.getHours())
              ) : (
                // Holds the line's height until the browser knows what time it is.
                <span className="invisible">Welcome</span>
              )}
            </h1>
            <p className="min-h-[22px] text-[14.5px] text-pretty text-muted-foreground">
              {state && teamSummary(state)}
            </p>
          </div>
          {/* Where the side column falls below, the offline notice stays up top. */}
          {offline && botIds.length > 0 && (
            <ComputerOffline botNames={botNames} className="-mt-2 xl:hidden" />
          )}
          {/* The suggestion sits right under what needs you, apart from it. */}
          <div className="flex flex-col gap-2 empty:hidden">
            <NeedsYou />
            <Suggestions />
          </div>
          <Briefing />
          <ProfileNudge />
          <Teammates />
          {!offline && <Activity />}
        </div>
        <div className="flex min-w-0 flex-col gap-8 xl:self-start">
          {/* Takeover requests are already in "Needs you", so the panel leaves them out. */}
          <ComputerPanel
            botIds={botIds}
            showRequests={false}
            className={offline ? "max-xl:hidden" : undefined}
          />
          <ComingUp now={minute === null ? null : minute * 60_000} />
          <RecentPages />
          {/* The offline card is short, so recent activity fills the side column instead. */}
          {offline && <Activity />}
        </div>
      </div>
    </div>
  );
}
