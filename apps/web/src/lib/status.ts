import type { BotActivity } from "@/components/bot-avatar";
import type { AppState, BotSummary } from "./types";

/** The line a teammate shows while their work waits for the computer to come back. */
export const PAUSED_OFFLINE = "Paused, computer offline";

/**
 * Whether the computer can do work right now: the worker is up and connected to it. While it
 * isn't, nothing a teammate started can move forward, so nothing should claim it is working.
 */
export function isComputerOnline(state: Pick<AppState, "computer"> | undefined): boolean {
  return Boolean(state?.computer.online && state.computer.workerOnline);
}

/**
 * What a teammate is doing, for their status light. Work in progress or up next is paused while
 * the computer is offline; a teammate waiting on you still needs you, offline or not.
 */
export function botActivity(
  bot: Pick<BotSummary, "activeRun">,
  computerOnline = true,
): BotActivity {
  const run = bot.activeRun;
  if (!run) return "idle";
  if (run.status === "waiting") return "waiting";
  if (!computerOnline) return "paused";
  if (run.status === "queued") return "queued";
  return "working";
}

/** What a teammate needs from you, in the words used everywhere, or null when they need nothing. */
export function botNeedsText(bot: Pick<BotSummary, "activeRun">): string | null {
  const run = bot.activeRun;
  if (run?.status !== "waiting") return null;
  return run.waitingFor === "takeover" ? "Needs you to take over" : "Needs your approval";
}

/**
 * The line under a teammate's name in lists: their job, unless they need you or their work is
 * paused. Whether they are working shows on the avatar's light, so the line stays put while they work.
 */
export function botSubtitle(
  bot: Pick<BotSummary, "activeRun" | "role">,
  computerOnline = true,
): string {
  if (botActivity(bot, computerOnline) === "paused") return PAUSED_OFFLINE;
  return botNeedsText(bot) ?? bot.role;
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
