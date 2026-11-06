import type { BotActivity } from "@/components/bot-avatar";
import type { BotSummary } from "./types";

export function botActivity(bot: Pick<BotSummary, "activeRun">): BotActivity {
  const run = bot.activeRun;
  if (!run) return "idle";
  if (run.status === "waiting") return "waiting";
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
 * The line under a teammate's name in lists: their job, unless they need you.
 * Whether they are working shows on the avatar's light, so the line stays put while they work.
 */
export function botSubtitle(bot: Pick<BotSummary, "activeRun" | "role">): string {
  return botNeedsText(bot) ?? bot.role;
}
