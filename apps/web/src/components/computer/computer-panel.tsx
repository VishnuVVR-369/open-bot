"use client";

import type { LeaseHolder, ScreenStatus } from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ClipboardPaste,
  Expand,
  Globe,
  Hand,
  Home,
  Loader2,
  Maximize2,
  Moon,
  MousePointer2,
  Power,
  Undo2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dismissTakeoverRequest, handBackScreen, takeOverScreen, wakeScreen } from "@/lib/actions";
import { queryKeys, useAppState } from "@/lib/client/queries";
import type { AppState, BotSummary, TakeoverRequestSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DesktopView, type DesktopConnection, type DesktopHandle } from "./desktop-view";

export type ScreenActivity = "you" | "working" | "idle" | "asleep" | "offline";

export interface ScreenInfo {
  bot: BotSummary;
  status: ScreenStatus | null;
  lease: LeaseHolder;
  activity: ScreenActivity;
  requests: TakeoverRequestSummary[];
}

/** The app state as it is once you hand a screen back. */
function releaseScreen(state: AppState, screenId: string): AppState {
  const health = state.computer.health;
  return {
    ...state,
    activeTakeovers: state.activeTakeovers.filter((takeover) => takeover.screenId !== screenId),
    computer: {
      ...state.computer,
      health: health && {
        ...health,
        screens: health.screens.map((screen) =>
          screen.id === screenId && screen.lease?.kind === "user"
            ? { ...screen, lease: null }
            : screen,
        ),
      },
    },
  };
}

/** The computer and every bot's screen on it. */
export function useComputer(initial?: AppState) {
  const { data } = useAppState(initial);
  const state = data ?? initial;
  const online = Boolean(state?.computer.online && state.computer.workerOnline);
  const screens = state?.computer.health?.screens ?? [];
  const requests = state?.takeoverRequests ?? [];

  function screen(botId: string): ScreenInfo | null {
    const bot = state?.bots.find((b) => b.id === botId);
    if (!bot) return null;
    const status = screens.find((s) => s.id === botId) ?? null;
    const lease = status?.lease ?? null;
    const activity: ScreenActivity = !online
      ? "offline"
      : lease?.kind === "user"
        ? "you"
        : lease?.kind === "run"
          ? "working"
          : status?.state === "running"
            ? "idle"
            : "asleep";
    return {
      bot,
      status,
      lease,
      activity,
      requests: requests.filter((request) => request.screenId === botId),
    };
  }

  const controlled = screens
    .filter((s) => s.lease?.kind === "user")
    .map((s) => s.id)
    .filter((id) => state?.bots.some((bot) => bot.id === id));

  return {
    state,
    online,
    workerOnline: state?.computer.workerOnline ?? false,
    egress: state?.computer.egress,
    requests,
    screens,
    screen,
    /** Screens you have control of. */
    controlled,
  };
}

/**
 * Which of these bots' screens to show. It follows the action until you pick one:
 * a screen you control, then one a bot asks you to take over, then the one most recently busy.
 */
export function useFollowedScreen(botIds: string[], initial?: AppState) {
  const { screen } = useComputer(initial);
  const [picked, setPicked] = useState<string | null>(null);
  const infos = botIds.map(screen).filter((info): info is ScreenInfo => info !== null);
  const valid = picked && infos.some((info) => info.bot.id === picked) ? picked : null;
  const busiest = [...infos]
    .filter((info) => info.lease?.kind === "run")
    .sort((a, b) =>
      (b.lease?.kind === "run" ? b.lease.lastActionAt : "").localeCompare(
        a.lease?.kind === "run" ? a.lease.lastActionAt : "",
      ),
    )[0];
  const followed =
    infos.find((info) => info.activity === "you") ??
    infos.find((info) => info.requests.length > 0) ??
    busiest ??
    infos.find((info) => info.bot.activeRun && info.bot.activeRun.status !== "queued") ??
    infos.find((info) => info.activity === "idle") ??
    infos[0];
  return {
    screenId: valid ?? followed?.bot.id ?? null,
    pick: setPicked,
    following: valid === null,
  };
}

const ACTIVITY_LABEL: Record<ScreenActivity, string> = {
  you: "You have control",
  working: "Working",
  idle: "Idle",
  asleep: "Asleep",
  offline: "Offline",
};

/** What a screen is doing, in a word. A screen on its way up isn't asleep. */
function activityLabel(info: ScreenInfo): string {
  return info.activity === "asleep" && info.status?.state === "starting"
    ? "Starting"
    : ACTIVITY_LABEL[info.activity];
}

function ActivityDot({ activity, className }: { activity: ScreenActivity; className?: string }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        activity === "working" && "animate-tally bg-live",
        activity === "you" && "bg-manual",
        activity === "idle" && "bg-done",
        (activity === "asleep" || activity === "offline") && "bg-bezel-foreground/35",
        className,
      )}
    />
  );
}

/** Whose screen this is, and what's happening on it. */
function ScreenBadge({ info }: { info: ScreenInfo }) {
  const key =
    info.activity === "working" && info.lease?.kind === "run" ? info.lease.runId : info.activity;
  return (
    <div className="flex min-w-0 items-center gap-2" aria-live="polite">
      <BotAvatar name={info.bot.name} color={info.bot.color} emoji={info.bot.emoji} size="xs" />
      <span className="truncate text-[12.5px] font-medium text-bezel-foreground">
        {info.bot.name}&rsquo;s screen
      </span>
      <div className="relative h-6 min-w-0 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={key}
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-full bg-white/[0.06] px-2 text-[11.5px] font-medium whitespace-nowrap text-bezel-foreground/75",
              info.activity === "you" && "text-manual",
            )}
          >
            {info.activity === "you" ? (
              <Hand className="size-3" />
            ) : (
              <ActivityDot activity={info.activity} className="size-1.5" />
            )}
            {activityLabel(info)}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

function EgressChip({ initial }: { initial?: AppState }) {
  const { egress } = useComputer(initial);
  if (!egress) return null;
  const home = egress.mode !== "off" && egress.agentOnline;
  const blocked = egress.mode === "require" && !egress.agentOnline;
  const label = home ? "Home connection" : blocked ? "Browsing paused" : "Cloud connection";
  const hint = home
    ? "The computer's browsers go online through your desktop app, so websites see your home IP."
    : blocked
      ? "Browsing only through your desktop is on, and the desktop app isn't connected. Open it to let the browsers load pages."
      : egress.mode === "off"
        ? "The browsers go online directly from the cloud computer."
        : "Your desktop app isn't connected, so the browsers go online directly from the cloud computer.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/settings#browsing"
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-bezel-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-bezel-foreground",
            blocked && "text-manual",
          )}
        >
          {home ? <Home className="size-3.5" /> : <Globe className="size-3.5" />}
          <span className="hidden 2xl:inline">{label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** The rim takes the bot's color while it works, amber while you have control. */
function rimColor(info: ScreenInfo | null): string {
  if (!info) return "transparent";
  if (info.activity === "you") return "var(--manual)";
  if (info.activity === "working") return info.bot.color;
  return "transparent";
}

function WakeButton({ screenId }: { screenId: string }) {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  return (
    <Button
      size="sm"
      variant="secondary"
      className="bg-white/10 text-bezel-foreground hover:bg-white/15"
      disabled={pending}
      data-testid="wake-screen"
      onClick={() =>
        startTransition(async () => {
          const result = await wakeScreen(screenId);
          if (!result.ok) toast.error(result.error);
          await queryClient.invalidateQueries({ queryKey: queryKeys.state });
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Power />}
      {pending ? "Waking up…" : "Wake screen"}
    </Button>
  );
}

/** The glass: the bot's live screen, or why it isn't showing. */
export function ScreenGlass({
  screenId,
  initial,
  className,
  handleRef,
}: {
  screenId: string;
  initial?: AppState;
  className?: string;
  handleRef?: React.RefObject<DesktopHandle | null>;
}) {
  const { screen, workerOnline, online } = useComputer(initial);
  const info = screen(screenId);
  const youHaveControl = info?.activity === "you";
  const running = info?.status?.state === "running";
  const [connection, setConnection] = useState<DesktopConnection>("connecting");
  // The "your input controls the screen" hint shows briefly, then gets out of the way.
  const [hintVisible, setHintVisible] = useState(false);
  useEffect(() => {
    if (!youHaveControl || connection !== "connected") {
      setHintVisible(false);
      return;
    }
    setHintVisible(true);
    const timer = setTimeout(() => setHintVisible(false), 3500);
    return () => clearTimeout(timer);
  }, [youHaveControl, connection]);

  let placeholder: ReactNode = null;
  if (!workerOnline || !online) {
    placeholder = (
      <>
        <span className="text-[14px] font-medium text-bezel-foreground">
          {workerOnline ? "The computer is starting or offline" : "The worker isn't running"}
        </span>
        <span className="text-[12.5px]">
          {workerOnline
            ? "It reconnects on its own. If it doesn't, check the computer container."
            : "Start everything with pnpm dev, and this screen connects by itself."}
        </span>
      </>
    );
  } else if (info && !running) {
    const starting = info.status?.state === "starting";
    placeholder = (
      <>
        {starting ? (
          <Loader2 className="mb-1 size-5 animate-spin" />
        ) : (
          <Moon className="mb-1 size-5" />
        )}
        <span className="text-[14px] font-medium text-bezel-foreground">
          {starting ? `Starting ${info.bot.name}'s screen…` : `${info.bot.name}'s screen is asleep`}
        </span>
        {!starting && (
          <>
            <span className="max-w-72 text-[12.5px]">
              It wakes up when {info.bot.name} uses the desktop, or when you take over.
            </span>
            <div className="mt-2.5">
              <WakeButton screenId={screenId} />
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-black",
        className,
      )}
      data-activity={info?.activity ?? "none"}
      data-testid="computer-screen"
    >
      {placeholder === null ? (
        <DesktopView
          key={screenId}
          screenId={screenId}
          mode={youHaveControl ? "control" : "view"}
          onStatus={setConnection}
          handleRef={handleRef}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[radial-gradient(ellipse_at_top,rgb(255_255_255/0.05),transparent_60%)] px-6 text-center text-bezel-foreground/70">
          {placeholder}
        </div>
      )}
      <div
        aria-hidden={!hintVisible}
        className={cn(
          "pointer-events-none absolute top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-manual px-3 py-1 text-[11.5px] font-semibold whitespace-nowrap text-black shadow-lg transition-all duration-500",
          hintVisible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
        )}
      >
        Your mouse and keyboard control this screen
      </div>
    </div>
  );
}

/** The monitor: a dark bezel whose rim takes the color of whoever is using the screen. */
export function ScreenFrame({
  screenId,
  initial,
  handleRef,
  className,
}: {
  screenId: string;
  initial?: AppState;
  handleRef?: React.RefObject<DesktopHandle | null>;
  className?: string;
}) {
  const { screen } = useComputer(initial);
  const info = screen(screenId);
  const rim = rimColor(info);
  const frameRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={frameRef}
      className={cn(
        "flex flex-col gap-2 rounded-[22px] bg-bezel p-2.5 transition-shadow duration-500 dark:outline dark:outline-1 dark:outline-white/[0.07] [&:fullscreen]:justify-center [&:fullscreen]:rounded-none [&:fullscreen]:p-6",
        className,
      )}
      style={{
        boxShadow: `0 0 0 2px ${rim}, 0 0 0 6px color-mix(in oklab, ${rim} 20%, transparent), 0 24px 48px -24px rgb(0 0 0 / 0.5)`,
      }}
    >
      <div className="flex h-7 items-center justify-between gap-2 pr-0.5 pl-1.5">
        {info ? <ScreenBadge info={info} /> : <span />}
        <div className="flex items-center">
          <EgressChip initial={initial} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex size-7 items-center justify-center rounded-full text-bezel-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-bezel-foreground"
                aria-label="Full screen"
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else void frameRef.current?.requestFullscreen?.();
                }}
              >
                <Maximize2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Full screen</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScreenGlass screenId={screenId} initial={initial} handleRef={handleRef} />
    </div>
  );
}

function HandBackButton({
  screenId,
  botName,
  size = "default",
}: {
  screenId: string;
  botName: string;
  size?: "default" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();

  function submit() {
    startTransition(async () => {
      // Let go here first, so the screen stops taking your input and its connection closes cleanly.
      await queryClient.cancelQueries({ queryKey: queryKeys.state });
      queryClient.setQueryData<AppState>(queryKeys.state, (state) =>
        state ? releaseScreen(state, screenId) : state,
      );
      const result = await handBackScreen(screenId, note.trim() || null);
      if (!result.ok) {
        toast.error(result.error);
        await queryClient.invalidateQueries({ queryKey: queryKeys.state });
        return;
      }
      setOpen(false);
      setNote("");
      toast("Handed back", { description: `${botName} can use the screen again.` });
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size={size}
          className="bg-manual text-black hover:bg-manual/85"
          data-testid="hand-back"
        >
          <Undo2 />
          Hand back
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Hand the screen back to {botName}</span>
            <span className="text-[13px] text-muted-foreground">
              Leave a note so {botName} knows what you did. Optional.
            </span>
          </div>
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Signed in to GitHub. Carry on."
            className="min-h-20 resize-none"
            data-testid="hand-back-note"
          />
          <Button type="submit" disabled={pending} data-testid="hand-back-confirm">
            {pending && <Loader2 className="animate-spin" />}
            Hand back
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function TakeOverButton({
  screenId,
  size = "default",
  label = "Take over",
}: {
  screenId: string;
  size?: "default" | "lg" | "sm";
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  return (
    <Button
      size={size}
      variant="outline"
      data-testid="take-over"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await takeOverScreen(screenId);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          await queryClient.invalidateQueries({ queryKey: queryKeys.state });
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <MousePointer2 />}
      {label}
    </Button>
  );
}

/** The bar under a screen: take over or hand back, plus its bot's requests. */
export function ScreenControls({
  screenId,
  initial,
  handleRef,
  expand = true,
}: {
  screenId: string;
  initial?: AppState;
  handleRef?: React.RefObject<DesktopHandle | null>;
  expand?: boolean;
}) {
  const { screen, online } = useComputer(initial);
  const queryClient = useQueryClient();
  const info = screen(screenId);
  if (!info) return null;
  const youHaveControl = info.activity === "you";
  const request = info.requests[0];
  const name = info.bot.name;

  return (
    <div className="flex flex-col gap-2.5">
      {request && !youHaveControl && (
        <div
          className="flex flex-col gap-2.5 rounded-xl border border-manual/40 bg-manual/[0.07] p-3.5"
          role="status"
        >
          <div className="flex items-start gap-2.5">
            <Hand className="mt-0.5 size-4 shrink-0 text-manual-ink" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium">{name} needs you to take over</span>
              <span className="text-[13px] text-muted-foreground">{request.reason}</span>
            </div>
          </div>
          <div className="flex gap-1.5 pl-6.5">
            <TakeOverButton screenId={screenId} size="sm" />
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await dismissTakeoverRequest(request.id);
                if (!result.ok) toast.error(result.error);
                await queryClient.invalidateQueries({ queryKey: queryKeys.state });
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted-foreground">
          {youHaveControl
            ? `${name} can't use this screen until you hand it back.`
            : info.activity === "working"
              ? `Watching ${name}. Take over at any time; ${name} stops right away.`
              : info.activity === "idle"
                ? `${name} isn't using the screen. Take over to sign in to sites; every teammate gets the sign-in.`
                : info.activity === "asleep"
                  ? `Sign-ins you make here work on every teammate's screen.`
                  : ""}
        </p>
        {youHaveControl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Paste your clipboard into the screen"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    handleRef?.current?.pasteText(text);
                    handleRef?.current?.focus();
                    toast("Clipboard sent", {
                      description: "Press Ctrl+V on the screen to paste it.",
                    });
                  } catch {
                    toast.error("Allow clipboard access to paste into the screen.");
                  }
                }}
              >
                <ClipboardPaste />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send your clipboard</TooltipContent>
          </Tooltip>
        )}
        {expand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" asChild>
                <Link href={`/computer?screen=${screenId}`} aria-label="Open the computer">
                  <Expand />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open the computer</TooltipContent>
          </Tooltip>
        )}
        {youHaveControl ? (
          <HandBackButton screenId={screenId} botName={name} />
        ) : (
          online && <TakeOverButton screenId={screenId} />
        )}
      </div>
    </div>
  );
}

/** Pick which teammate's screen to watch. */
/** How many screens show as tabs before the rest move into a menu. */
const VISIBLE_SCREENS = 4;

function ScreenTab({
  info,
  selected,
  onSelect,
}: {
  info: ScreenInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-[12.5px] font-medium transition-colors",
        selected
          ? "border-foreground/15 bg-card text-foreground shadow-xs"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      data-testid={`screen-tab-${info.bot.slug}`}
    >
      <BotAvatar name={info.bot.name} color={info.bot.color} emoji={info.bot.emoji} size="xs" />
      <span className="max-w-[112px] truncate">{info.bot.name}</span>
      <ActivityDot
        activity={info.activity}
        className={cn(
          "size-1.5",
          (info.activity === "asleep" || info.activity === "offline") && "bg-muted-foreground/40",
        )}
      />
    </button>
  );
}

/**
 * Tabs for switching between screens. The selected screen and the busy ones always get a tab;
 * the rest wait in a "+N" menu, so the row never runs off the edge.
 */
export function ScreenPicker({
  botIds,
  value,
  onChange,
  initial,
  className,
}: {
  botIds: string[];
  value: string | null;
  onChange: (screenId: string) => void;
  initial?: AppState;
  className?: string;
}) {
  const { screen } = useComputer(initial);
  const infos = botIds.map(screen).filter((info): info is ScreenInfo => info !== null);
  if (infos.length < 2) return null;

  const shown = new Set<string>();
  const want = (info: ScreenInfo) => {
    if (shown.size < VISIBLE_SCREENS) shown.add(info.bot.id);
  };
  const awake = (info: ScreenInfo) => info.activity !== "asleep" && info.activity !== "offline";
  // With one spare tab or less, show them all rather than a "+1" menu.
  const overflow = infos.length > VISIBLE_SCREENS + 1;
  if (overflow) {
    infos.filter((info) => info.bot.id === value).forEach(want);
    infos.filter((info) => info.activity === "you" || info.activity === "working").forEach(want);
    infos.filter(awake).forEach(want);
    infos.forEach(want);
  }
  const visible = overflow ? infos.filter((info) => shown.has(info.bot.id)) : infos;
  const hidden = overflow ? infos.filter((info) => !shown.has(info.bot.id)) : [];

  return (
    <div
      role="tablist"
      aria-label="Screens"
      className={cn("-mx-1 flex min-w-0 items-center gap-1 px-1 pb-0.5", className)}
    >
      {visible.map((info) => (
        <ScreenTab
          key={info.bot.id}
          info={info}
          selected={info.bot.id === value}
          onSelect={() => onChange(info.bot.id)}
        />
      ))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
              aria-label={`${hidden.length} more screens`}
              data-testid="more-screens"
            >
              +{hidden.length}
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56">
            {hidden.map((info) => (
              <DropdownMenuItem key={info.bot.id} onSelect={() => onChange(info.bot.id)}>
                <BotAvatar
                  name={info.bot.name}
                  color={info.bot.color}
                  emoji={info.bot.emoji}
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate">{info.bot.name}</span>
                <span className="text-[12px] text-muted-foreground">{activityLabel(info)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The computer as a panel: the bots' screens, one at a time, with their controls. */
export function ComputerPanel({
  botIds,
  initial,
  loading = false,
  className,
}: {
  /** Whose screens to offer. The panel follows whichever is busy. */
  botIds: string[];
  initial?: AppState;
  /** Whose screens they are isn't known yet. */
  loading?: boolean;
  className?: string;
}) {
  const handleRef = useRef<DesktopHandle | null>(null);
  const { state } = useComputer(initial);
  const { screenId, pick } = useFollowedScreen(botIds, initial);
  if (!screenId) {
    return (
      <section
        aria-label="Computer"
        aria-busy={loading || !state}
        className={cn(
          "flex aspect-[16/11] flex-col items-center justify-center gap-1.5 rounded-[22px] bg-bezel px-8 text-center text-bezel-foreground/70",
          className,
        )}
      >
        {!loading && state && (
          <>
            <span className="text-[14px] font-medium text-bezel-foreground">No screens yet</span>
            <span className="text-[12.5px]">
              Every teammate gets their own screen on the shared computer.
            </span>
          </>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Computer" className={cn("flex flex-col gap-3", className)}>
      <ScreenPicker botIds={botIds} value={screenId} onChange={pick} initial={initial} />
      <ScreenFrame screenId={screenId} initial={initial} handleRef={handleRef} />
      <ScreenControls screenId={screenId} initial={initial} handleRef={handleRef} />
    </section>
  );
}
