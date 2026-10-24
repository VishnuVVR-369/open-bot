import type { BotActivity } from "@/components/bot-avatar";
import type { BotSummary } from "./types";

export function botActivity(bot: Pick<BotSummary, "activeRun">): BotActivity {
  const run = bot.activeRun;
  if (!run) return "idle";
  if (run.status === "waiting") return "waiting";
  if (run.status === "queued") return "queued";
  return "working";
}

export function botStatusText(bot: Pick<BotSummary, "activeRun" | "role">): string {
  const run = bot.activeRun;
  if (!run) return bot.role;
  if (run.status === "waiting")
    return run.waitingFor === "takeover" ? "Needs you to take over" : "Needs your approval";
  if (run.status === "queued") return "Up next";
  return "Working…";
}
