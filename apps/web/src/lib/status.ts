import type { BotActivity } from "@/components/bot-avatar";
import type { AppState, BotSummary } from "./types";

/**
 * The words for a teammate's status, the same on every surface: the sidebar, Home, the computer's
 * screen list and the chat header. The line under a teammate's name says only this, never their job.
 */
export const STATUS = {
  approval: "Needs your approval",
  takeover: "Needs you to take over",
  working: "Working",
  /** Online, but waiting for a free turn on the computer. */
  upNext: "Up next",
  /** The computer is offline, so nothing they do can move. */
  paused: "Paused",
  idle: "Idle",
} as const;

export type StatusLabel = (typeof STATUS)[keyof typeof STATUS];

/** A scheduled run whose time has come while the computer is offline. */
export const WAITING_FOR_COMPUTER = "Waiting for the computer";

/** Whether a scheduled run is due but can't start: its time has passed and the computer is offline. */
export function runIsHeldBack(nextRunAt: string, now: number, computerOnline: boolean): boolean {
  return !computerOnline && new Date(nextRunAt).getTime() <= now;
}

/** Said once on a surface, to explain why every row says "Paused". */
export const COMPUTER_OFFLINE_LINE = "Computer offline";

/**
 * Whether the computer can do work right now: the worker is up and connected to it. While it
 * isn't, nothing a teammate started can move forward, so nothing should claim it is working.
 */
export function isComputerOnline(state: Pick<AppState, "computer"> | undefined): boolean {
  return Boolean(state?.computer.online && state.computer.workerOnline);
}

/**
 * What a teammate is doing, for their status light. A teammate waiting on you still needs you,
 * offline or not; everyone else is paused while the computer is offline, with or without work.
 */
export function botActivity(
  bot: Pick<BotSummary, "activeRun">,
  computerOnline = true,
): BotActivity {
  const run = bot.activeRun;
  if (run?.status === "waiting") return "waiting";
  if (!computerOnline) return "paused";
  if (!run) return "idle";
  if (run.status === "queued") return "queued";
  return "working";
}

/** What a teammate needs from you, in the words used everywhere, or null when they need nothing. */
export function botNeedsText(bot: Pick<BotSummary, "activeRun">): string | null {
  const run = bot.activeRun;
  if (run?.status !== "waiting") return null;
  return run.waitingFor === "takeover" ? STATUS.takeover : STATUS.approval;
}

export interface TeammateStatus {
  /** The words under their name. */
  label: StatusLabel;
  /** For their avatar's light. */
  activity: BotActivity;
  /** They are waiting on you: the line turns amber. */
  needsYou: boolean;
}

/** A teammate's status line and light, from the fixed list in `STATUS`. */
export function teammateStatus(
  bot: Pick<BotSummary, "activeRun">,
  computerOnline = true,
): TeammateStatus {
  const activity = botActivity(bot, computerOnline);
  const label: StatusLabel =
    activity === "waiting"
      ? bot.activeRun?.waitingFor === "takeover"
        ? STATUS.takeover
        : STATUS.approval
      : activity === "paused"
        ? STATUS.paused
        : activity === "working"
          ? STATUS.working
          : activity === "queued"
            ? STATUS.upNext
            : STATUS.idle;
  return { label, activity, needsYou: activity === "waiting" };
}

/**
 * Why a task didn't finish, as it stands now. An error written at the time ("Try again in a
 * minute") goes stale, so the advice is left out: the row offers its own way to try again.
 */
export function failureLine(error: string | null): string {
  const text = (error ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "It stopped before it was done.";
  if (/\b(restart|restarted|restarting|rebooted)\b/i.test(text))
    return "Interrupted when the computer restarted.";
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const kept = sentences
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) => !/^(please\s+)?(try|retry)\b.*\b(again|later|minute|moment)\b/i.test(sentence),
    );
  return kept.join(" ") || "It stopped before it was done.";
}
