"use client";

import { Activity, Globe, Hand, Home } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { useAppState } from "@/lib/client/queries";
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
    <h2 className="flex items-center gap-1.5 text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
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
      return "Offline";
  }
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
          {screenId ? (
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
                              : "idle"
                        }
                        className={
                          selected
                            ? "[&>span:last-child]:ring-card"
                            : "[&>span:last-child]:ring-surface"
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-medium">{info.bot.name}</span>
                        <span
                          className={cn(
                            "truncate text-[12.5px] text-muted-foreground",
                            (info.activity === "you" || info.requests.length > 0) &&
                              "text-manual-ink",
                          )}
                        >
                          {screenLine(info, chat)}
                        </span>
                      </span>
                      {info.activity === "you" && <Hand className="size-3.5 text-manual-ink" />}
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
              className="flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors hover:border-foreground/20"
            >
              {home ? (
                <Home className="mt-0.5 size-4 text-done" />
              ) : (
                <Globe className="mt-0.5 size-4 text-muted-foreground" />
              )}
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium">
                  {home ? "Through your home connection" : "Straight from the cloud"}
                </span>
                <span className="text-[12.5px] text-muted-foreground">
                  {home && egress?.stats
                    ? `${egress.stats.openStreams} open connections · ${formatBytes(egress.stats.bytesIn + egress.stats.bytesOut)} relayed`
                    : egress?.mode === "off"
                      ? "Routing through your desktop is off."
                      : "Open the desktop app to browse from your home IP."}
                </span>
              </span>
            </Link>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionTitle>
              <Activity className="size-3.5" /> Health
            </SectionTitle>
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {[
                {
                  label: "Computer",
                  ok: online,
                  value: online ? "Online" : "Offline",
                },
                {
                  label: "Agent runtime",
                  ok: health?.agent === "running",
                  value: health?.agent
                    ? health.agent[0]!.toUpperCase() + health.agent.slice(1)
                    : "Offline",
                },
                {
                  label: "Screens running",
                  ok: true,
                  value: `${running} of ${botIds.length}`,
                },
              ].map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between px-3.5 py-2 text-[13px]"
                >
                  <span>{row.label}</span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      row.ok ? "text-muted-foreground" : "text-destructive",
                    )}
                  >
                    <span
                      className={cn("size-1.5 rounded-full", row.ok ? "bg-done" : "bg-destructive")}
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
