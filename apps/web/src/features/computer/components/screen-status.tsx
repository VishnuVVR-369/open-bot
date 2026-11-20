"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, Globe, Hand, Home, Loader2, Power } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type ScreenActivity, type ScreenInfo, useComputer } from "../hooks";

const ACTIVITY_LABEL: Record<ScreenActivity, string> = {
  you: "You have control",
  working: "Working",
  idle: "Idle",
  asleep: "Asleep",
  offline: "Offline",
};

/** What a screen is doing, in a word. A screen on its way up isn't asleep. */
export function activityLabel(info: ScreenInfo): string {
  return info.activity === "asleep" && info.status?.state === "starting"
    ? "Starting"
    : ACTIVITY_LABEL[info.activity];
}

export function ActivityDot({
  activity,
  className,
}: {
  activity: ScreenActivity;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        activity === "working" && "animate-tally bg-working",
        activity === "you" && "bg-attention",
        (activity === "idle" || activity === "asleep" || activity === "offline") &&
          "bg-bezel-foreground/35",
        className,
      )}
    />
  );
}

/** Whose screen this is, and what's happening on it. */
export function ScreenBadge({ info }: { info: ScreenInfo }) {
  const key =
    info.activity === "working" && info.lease?.kind === "run" ? info.lease.runId : info.activity;
  return (
    <div className="flex min-w-0 items-center gap-2" aria-live="polite">
      <TeammateAvatar
        name={info.teammate.name}
        color={info.teammate.color}
        emoji={info.teammate.emoji}
        size="xs"
      />
      <span className="truncate text-[12.5px] font-medium text-bezel-foreground">
        {info.teammate.name}&rsquo;s screen
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
              info.activity === "you" && "text-attention",
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

export function EgressChip({ initial }: { initial?: AppState }) {
  const { egress } = useComputer(initial);
  if (!egress) return null;
  const home = egress.mode !== "off" && egress.agentOnline;
  const blocked = egress.mode === "require" && !egress.agentOnline;
  const label = home ? "Home internet" : blocked ? "Browsing paused" : "Computer's internet";
  const hint = home
    ? "Browsing through your home internet, by way of your desktop app, so websites see your home."
    : blocked
      ? "Browsing only through your home internet is on, and the desktop app isn't open. Open it so pages load."
      : egress.mode === "off"
        ? "Browsing on the computer's own internet. Websites see the cloud computer, not your home."
        : "Browsing on the computer's own internet, since the desktop app isn't open.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/settings#browsing"
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-bezel-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-bezel-foreground",
            blocked && "text-attention",
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

/** The rim takes the teammate's color while it works, amber while you have control. */
export function rimColor(info: ScreenInfo | null): string {
  if (!info) return "transparent";
  if (info.activity === "you") return "var(--attention)";
  if (info.activity === "working") return info.teammate.color;
  return "transparent";
}

export function WakeButton({ screenId }: { screenId: string }) {
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
          const result = await attempt(api.screens.wake({ screenId }));
          if (!result.ok) toast.error(result.error);
          await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Power />}
      {pending ? "Waking up…" : "Wake screen"}
    </Button>
  );
}

/**
 * The computer is offline: one short card in place of a dark, empty screen.
 * Takeover requests still show where you are asked for them (Home, the chat), not here.
 */
export function ComputerOffline({
  teammateNames,
  className,
}: {
  /** Whose screens these are, to say who is affected. */
  teammateNames: string[];
  className?: string;
}) {
  const who = teammateNames.length === 1 ? `${teammateNames[0]} pauses` : "Teammates pause";
  return (
    <section
      aria-label="Computer"
      className={cn(
        "flex items-start gap-3 rounded-xl bg-card px-4 py-3.5 shadow-raised",
        className,
      )}
      data-testid="computer-offline"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
        <CloudOff className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium">The computer is offline</span>
        <span className="text-[13px] leading-snug text-muted-foreground">
          {who} computer work until it&apos;s back. It reconnects on its own.
        </span>
      </div>
    </section>
  );
}
