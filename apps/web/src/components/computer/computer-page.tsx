"use client";

import { CloudOff, Globe, Hand, Home } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useAppState } from "@/lib/client/queries";
import { botActivity, botNeedsText, PAUSED_OFFLINE } from "@/lib/status";
import type { ChatSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ScreenControls,
  ScreenFrame,
  useComputer,
  useFollowedScreen,
  type ScreenInfo,
} from "./computer-panel";
import type { DesktopHandle } from "./desktop-view";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
      {children}
    </h2>
  );
}

/** Whether a screen's line asks something of you, which is the only time it turns amber. */
function needsYou(info: ScreenInfo): boolean {
  return (
    info.activity === "you" ||
    (info.activity !== "working" && info.requests.length > 0) ||
    (info.activity === "offline" && botNeedsText(info.bot) !== null)
  );
}

function screenLine(info: ScreenInfo, chat: ChatSummary | undefined): string {
  switch (info.activity) {
    case "you":
      return "You have control";
    case "working":
      return chat?.kind === "group"
        ? `Working in ${chat.title}`
        : chat?.kind === "scheduled"
          ? "Running a routine"
          : "Working on your request";
    case "idle":
      return info.requests.length ? "Needs you to take over" : "Idle";
    case "asleep":
      return info.requests.length ? "Needs you to take over" : "Asleep";
    case "offline":
      // What still stands while the computer is away: a request for you, or work waiting for it.
      if (info.requests.length) return "Needs you to take over";
      return botNeedsText(info.bot) ?? (info.bot.activeRun ? PAUSED_OFFLINE : "Offline");
  }
}

type HealthSignal = "done" | "idle" | "failed";

/**
 * The health rows. Green only for something up and running; offline or nothing running is a calm
 * gray; red only when a part is up but has failed.
 */
function healthRows({
  online,
  agent,
  running,
  screens,
}: {
  online: boolean;
  agent: string | undefined;
  running: number;
  screens: number;
}): { label: string; value: string; signal: HealthSignal }[] {
  return [
    { label: "Computer", value: online ? "Online" : "Offline", signal: online ? "done" : "idle" },
    {
      label: "Agent runtime",
      value: agent ? agent[0]!.toUpperCase() + agent.slice(1) : "Offline",
      signal: agent === "running" ? "done" : agent === "crashed" ? "failed" : "idle",
    },
    {
      label: "Screens running",
      value: `${running} of ${screens}`,
      signal: running > 0 ? "done" : "idle",
    },
  ];
}

/**
 * The computer is offline. There is no screen to show, so the page says so on its own surface
 * instead of a large black frame, and the take over request (if any) follows below it.
 */
function ComputerAway({ names }: { names: string[] }) {
  return (
    <section
      aria-label="Computer"
      className="flex flex-col items-center gap-2 rounded-2xl bg-card px-8 py-12 text-center shadow-raised"
      data-testid="computer-offline"
    >
      <span className="mb-1 flex size-11 items-center justify-center rounded-xl bg-subtle text-muted-foreground">
        <CloudOff className="size-5" />
      </span>
      <h1 className="text-[18px] font-semibold">The computer is offline</h1>
      <p className="max-w-md text-[14px] leading-relaxed text-muted-foreground">
        {names.length === 1 ? `${names[0]} pauses` : "Your teammates pause"} computer work until
        it&apos;s back. It reconnects on its own, and their screens show here again.
      </p>
    </section>
  );
}

export function ComputerPage({ initialScreen }: { initialScreen: string | null }) {
  const handleRef = useRef<DesktopHandle | null>(null);
  const { data: state } = useAppState();
  const { screen, egress, online } = useComputer();
  const botIds = state?.bots.map((bot) => bot.id) ?? [];
  const followed = useFollowedScreen(botIds);
  const [picked, setPicked] = useState<string | null>(initialScreen);
  const screenId = picked && botIds.includes(picked) ? picked : followed.screenId;
  const health = state?.computer.health;
  const home = egress && egress.mode !== "off" && egress.agentOnline;
  const running = health?.screens.filter((s) => s.state === "running").length ?? 0;

  // Keep the address in step with the screen you're looking at, so it can be shared or reloaded.
  useEffect(() => {
    if (!screenId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("screen") === screenId) return;
    url.searchParams.set("screen", screenId);
    window.history.replaceState(window.history.state, "", url);
  }, [screenId]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[1600px] gap-8 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {state && !online ? <ComputerAway names={state.bots.map((bot) => bot.name)} /> : null}
          {state && !online ? (
            screenId && <ScreenControls screenId={screenId} expand={false} />
          ) : screenId ? (
            <>
              <ScreenFrame screenId={screenId} handleRef={handleRef} />
              <ScreenControls screenId={screenId} handleRef={handleRef} expand={false} />
            </>
          ) : (
            <div
              className="flex aspect-[16/10] flex-col items-center justify-center gap-1.5 rounded-[22px] bg-bezel px-8 text-center text-bezel-foreground/70"
              aria-busy={!state}
            >
              {state && (
                <>
                  <span className="text-[15px] font-medium text-bezel-foreground">
                    No screens yet
                  </span>
                  <span className="text-[13px]">
                    Create a teammate, and they get their own screen on this computer.
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-2.5">
            <SectionTitle>Screens</SectionTitle>
            <ul className="flex flex-col gap-1" role="tablist" aria-label="Screens">
              {botIds.map((id) => {
                const info = screen(id);
                if (!info) return null;
                const selected = id === screenId;
                const chat = info.bot.activeRun
                  ? state?.chats.find((c) => c.id === info.bot.activeRun!.chatId)
                  : undefined;
                return (
                  <li key={id}>
                    <button
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setPicked(id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                        selected
                          ? "border-foreground/15 bg-card shadow-xs"
                          : "border-transparent hover:bg-muted",
                      )}
                      data-testid={`screen-row-${info.bot.slug}`}
                    >
                      <BotAvatar
                        name={info.bot.name}
                        color={info.bot.color}
                        emoji={info.bot.emoji}
                        size="sm"
                        activity={
                          info.activity === "working"
                            ? "working"
                            : info.requests.length && info.activity !== "you"
                              ? "waiting"
                              : info.activity === "offline"
                                ? botActivity(info.bot, false)
                                : "idle"
                        }
                        className={
                          selected
                            ? "[--avatar-ring:var(--card)]"
                            : "[--avatar-ring:var(--surface)]"
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-medium">{info.bot.name}</span>
                        <span
                          className={cn(
                            "truncate text-[12.5px] text-muted-foreground",
                            needsYou(info) && "text-attention-ink",
                          )}
                        >
                          {screenLine(info, chat)}
                        </span>
                      </span>
                      {info.activity === "you" && <Hand className="size-3.5 text-attention-ink" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="px-1 text-[12px] leading-relaxed text-muted-foreground">
              Every teammate has their own screen, so they can use the computer at the same time.
              Sign in to a site on any screen and every teammate is signed in.
            </p>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionTitle>Browsing</SectionTitle>
            <Link
              href="/settings#browsing"
              className="flex items-start gap-3 rounded-xl bg-card shadow-raised px-3.5 py-3 transition-shadow hover:shadow-float"
            >
              {home ? (
                <Home className="mt-0.5 size-4 shrink-0 text-done" />
              ) : (
                <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium">
                  {home ? "Through your home internet" : "On the computer's own internet"}
                </span>
                <span className="text-[12.5px] text-muted-foreground">
                  {home && egress?.stats
                    ? `${egress.stats.openStreams} open connections · ${formatBytes(egress.stats.bytesIn + egress.stats.bytesOut)} passed through`
                    : egress?.mode === "off"
                      ? "Websites see the cloud computer, not your home. You can change this in Settings."
                      : "Open the open-bot desktop app and websites see your home internet instead, which some sites trust more."}
                </span>
              </span>
            </Link>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionTitle>Health</SectionTitle>
            <ul className="flex flex-col divide-y divide-border/70 rounded-xl bg-card shadow-raised">
              {healthRows({
                online,
                agent: online ? health?.agent : undefined,
                running: online ? running : 0,
                screens: botIds.length,
              }).map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between px-3.5 py-2 text-[13px]"
                >
                  <span>{row.label}</span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        row.signal === "done" && "bg-done",
                        row.signal === "idle" && "bg-idle",
                        row.signal === "failed" && "bg-destructive",
                      )}
                    />
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
            {health && (
              <p className="text-[12px] text-muted-foreground">
                Up since {new Date(health.bootedAt).toLocaleString()}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
