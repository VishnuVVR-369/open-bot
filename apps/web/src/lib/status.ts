import { teammateStatus } from "@open-bot/shared";
import type { BotActivity } from "@/components/bot-avatar";
import type { AppState, BotSummary } from "./types";

// The words and the rules for a teammate's status are shared with the phone (packages/shared).
export { chatStatus, STATUS, teammateStatus } from "@open-bot/shared";
export type { ChatStatus, StatusLabel, TeammateStatus } from "@open-bot/shared";

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

/** What a teammate is doing, for their status light. */
export function botActivity(
  bot: Pick<BotSummary, "activeRun">,
  computerOnline = true,
): BotActivity {
  return teammateStatus(bot, computerOnline).activity;
}

/** What a teammate needs from you, in the words used everywhere, or null when they need nothing. */
export function botNeedsText(bot: Pick<BotSummary, "activeRun">): string | null {
  const status = teammateStatus(bot);
  return status.needsYou ? status.label : null;
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
