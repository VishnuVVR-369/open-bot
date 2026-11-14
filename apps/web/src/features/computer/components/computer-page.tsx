"use client";

import type { ScreenFrame as LastFrame } from "@open-bot/api";
import { fileSize } from "@open-bot/chat-core";
import { relativeTime } from "@open-bot/domain";
import { useQuery } from "@tanstack/react-query";
import { CloudOff, Globe, Hand, Home } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { orpc } from "@/lib/client/rpc";
import { useAppState } from "@/features/app-shell";
import { STATUS, teammateStatus, type TeammateStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { type ScreenInfo, useComputer, useFollowedScreen } from "../hooks";
import { ScreenFrame } from "./screen-glass";
import { ScreenControls } from "./screen-controls";
import type { ScreenHandle } from "./screen-view";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-1.5 font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
      {children}
    </h2>
  );
}

/**
 * A screen's line in the list, in the same words as everywhere else. Two things are particular
 * to screens: you holding one, and a teammate asking you to take one over.
 */
function screenStatus(info: ScreenInfo): Pick<TeammateStatus, "activity" | "needsYou"> & {
  label: string;
} {
  if (info.activity === "you")
    return { label: "You have control", activity: "idle", needsYou: true };
  if (info.requests.length > 0 && info.activity !== "working")
    return { label: STATUS.takeover, activity: "waiting", needsYou: true };
  if (info.activity === "working")
    return { label: STATUS.working, activity: "working", needsYou: false };
  return teammateStatus(info.bot, info.activity !== "offline");
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

/** The computer's state in a word, next to the page title. Details are in Health. */
function HealthPill({ signal, label }: { signal: HealthSignal; label: string }) {
  return (
    <a
      href="#health"
      className="flex h-6 items-center gap-1.5 rounded-full bg-subtle px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      data-testid="computer-health"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          signal === "done" && "bg-done",
          signal === "idle" && "bg-idle",
          signal === "failed" && "bg-destructive",
        )}
      />
      {label}
    </a>
  );
}

/** Each screen's last captured frame, by screen id, for while the computer is offline. */
function useScreenFrames(enabled: boolean) {
  return useQuery(orpc.screens.frames.queryOptions({ enabled, staleTime: 60_000 }));
}

/**
 * The computer is offline, so there is no live screen. With a frame the teammate captured, it shows
 * that, dimmed, with when it was taken: what you'd come back to. Without one, a short card says what
 * waits, on the page's own surface instead of a large black frame.
 */
function ScreenAway({ info, frame }: { info: ScreenInfo; frame: LastFrame | null }) {
  const name = info.bot.name;
  const status = screenStatus(info);
  const waiting =
    status.label === STATUS.takeover
      ? `${name} is waiting for you to take over.`
      : status.label === STATUS.approval
        ? `${name} is waiting for your approval.`
        : `${name}'s work is paused.`;
  if (frame)
    return (
      <section
        aria-label={`${name}'s screen`}
        className="relative aspect-[16/10] w-full overflow-hidden rounded-[22px] bg-bezel shadow-raised"
        data-testid="computer-offline"
      >
        <img
          src={`/api/artifacts/${frame.artifactId}`}
          alt={`${name}'s screen when it was last seen`}
          className="absolute inset-0 size-full object-cover opacity-40 grayscale-[40%]"
          data-testid="last-frame"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-black/10" />
        <span className="absolute top-4 left-4 flex h-7 items-center gap-1.5 rounded-full bg-black/55 px-2.5 text-[12.5px] font-medium text-white/85 backdrop-blur">
          <CloudOff className="size-3.5" />
          Last seen {relativeTime(frame.at)}
        </span>
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 p-5 text-white sm:p-6">
          <BotAvatar
            name={name}
            color={info.bot.color}
            emoji={info.bot.emoji}
            size="md"
            activity={status.activity}
            className="[--avatar-ring:#000]"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[16px] font-semibold">{name}&rsquo;s screen</h2>
            <p className="text-[13.5px] text-pretty text-white/75">
              {waiting} The live screen returns when the computer reconnects.
            </p>
          </div>
        </div>
      </section>
    );
  return (
    <section
      aria-label={`${name}'s screen`}
      className="flex items-center gap-4 rounded-2xl bg-card px-5 py-5 shadow-raised"
      data-testid="computer-offline"
    >
      <BotAvatar
        name={name}
        color={info.bot.color}
        emoji={info.bot.emoji}
        size="lg"
        activity={status.activity}
        className="[--avatar-ring:var(--card)]"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-[16px] font-semibold">{name}&rsquo;s screen</h2>
        <p className="text-[14px] leading-relaxed text-pretty text-muted-foreground">
          {waiting} The screen shows here when the computer is back.
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <CloudOff className="size-3.5 shrink-0" />
          The computer is offline. It reconnects on its own.
        </p>
      </div>
    </section>
  );
}

export function ComputerPage({ initialScreen }: { initialScreen: string | null }) {
  const handleRef = useRef<ScreenHandle | null>(null);
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

  const rows = healthRows({
    online,
    agent: online ? health?.agent : undefined,
    running: online ? running : 0,
    screens: botIds.length,
  });
  const pill =
    rows[1]!.signal === "failed"
      ? { signal: "failed" as const, label: "Agent runtime crashed" }
      : online
        ? {
            signal: "done" as const,
            label: `Online · ${running} of ${botIds.length} screens running`,
          }
        : { signal: "idle" as const, label: "Offline" };
  const selected = screenId ? screen(screenId) : null;
  const offline = Boolean(state) && !online;
  const { data: frames } = useScreenFrames(offline);

  return (
    <div className="h-full overflow-y-auto">
      {/* The same frame and title as every other page (see components/page.tsx), with a side rail. */}
      <div className="mx-auto grid w-full max-w-[1600px] gap-x-8 gap-y-8 px-5 py-8 sm:px-10 sm:py-12 lg:grid-cols-[minmax(0,1fr)_300px]">
        <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 lg:col-span-2">
          <h1 className="text-[28px] leading-tight font-semibold">Computer</h1>
          {state && <HealthPill signal={pill.signal} label={pill.label} />}
        </header>
        <div className="flex min-w-0 flex-col gap-4">
          {state && !online ? (
            selected && (
              <>
                <ScreenAway info={selected} frame={frames?.[selected.bot.id] ?? null} />
                <ScreenControls screenId={selected.bot.id} expand={false} />
              </>
            )
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
            <ul className="flex flex-col gap-0.5" role="tablist" aria-label="Screens">
              {botIds.map((id) => {
                const info = screen(id);
                if (!info) return null;
                const isSelected = id === screenId;
                const status = screenStatus(info);
                return (
                  <li key={id}>
                    <button
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => setPicked(id)}
                      className={cn(
                        "flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors",
                        isSelected
                          ? "border-foreground/15 bg-card shadow-xs"
                          : "border-transparent hover:bg-muted",
                      )}
                      title={`${info.bot.name}, ${info.bot.role}`}
                      data-testid={`screen-row-${info.bot.slug}`}
                    >
                      <BotAvatar
                        name={info.bot.name}
                        color={info.bot.color}
                        emoji={info.bot.emoji}
                        size="sm"
                        activity={status.activity}
                        className={
                          isSelected
                            ? "[--avatar-ring:var(--card)]"
                            : "[--avatar-ring:var(--surface)]"
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] leading-tight font-medium">
                          {info.bot.name}
                        </span>
                        <span
                          className={cn(
                            "truncate text-[12.5px] leading-tight text-muted-foreground",
                            status.needsYou && "text-attention-ink",
                          )}
                        >
                          {status.label}
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
                  {home ? "Your home internet" : "The computer's own internet"}
                </span>
                <span className="text-[12.5px] leading-snug text-pretty text-muted-foreground">
                  {home && egress?.stats
                    ? `Sites see your home connection. ${egress.stats.openStreams} open connections, ${fileSize(egress.stats.bytesIn + egress.stats.bytesOut)} passed through.`
                    : home
                      ? "Sites see your home connection, by way of your desktop app."
                      : egress?.mode === "off"
                        ? "Sites see the computer's internet. You can browse from your home connection instead in Settings."
                        : "Sites see the computer's internet. Open the desktop app to browse from your home connection instead."}
                </span>
              </span>
            </Link>
          </section>

          <section className="flex scroll-mt-6 flex-col gap-2.5" id="health">
            <SectionTitle>Health</SectionTitle>
            <ul className="flex flex-col divide-y divide-border/70 rounded-xl bg-card shadow-raised">
              {rows.map((row) => (
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
