import type { ActivityItem, TeammateSummary, BriefingItem, ChatSummary, Home } from "@open-bot/api";
import { plural } from "@open-bot/chat-core";
import { teammateStatus } from "@open-bot/domain";
import { conversationWith } from "../chat/chats";

/** How many recent turns from groups and automations Home shows. */
export const RECENT = 4;

/**
 * The line under the greeting: what's going on, in a few words. While the computer is offline
 * nobody is working, so it never says they are (the notice under it says why).
 */
export function statusLine(
  home: Home,
  teammates: TeammateSummary[],
  computerOffline = false,
  approvals = home.pendingApprovals,
): string {
  // What you can act on in the app, the same things the section under it lists one by one.
  const needs = approvals + home.takeoverRequests.length;
  if (needs > 0) return `${plural(needs, "thing")} ${needs === 1 ? "needs" : "need"} you.`;
  if (computerOffline) return "Nothing needs you. Work picks up when the computer is back.";
  const working = teammates.filter((teammate) => teammateStatus(teammate).activity === "working");
  if (working.length === 1) return `${working[0]!.name} is working on something.`;
  if (working.length > 1) return `${plural(working.length, "teammate")} are working right now.`;
  return "All quiet. Your teammates are ready when you are.";
}

/**
 * The briefing, one group per teammate in the order they first appear, newest first but what
 * failed before what went fine; and how many went fine and how many failed.
 */
export function briefingGroups(items: BriefingItem[]): {
  groups: [teammateId: string, items: BriefingItem[]][];
  done: number;
  failed: number;
} {
  const byTeammate = new Map<string, BriefingItem[]>();
  const ordered = [...items].sort(
    (a, b) => Number(b.status === "failed") - Number(a.status === "failed"),
  );
  for (const item of ordered)
    byTeammate.set(item.teammateId, [...(byTeammate.get(item.teammateId) ?? []), item]);
  const failed = items.filter((item) => item.status === "failed").length;
  return { groups: [...byTeammate.entries()], done: items.length - failed, failed };
}

/** Who needs you first, then who's working, then everyone by their latest conversation. */
export function rankTeammates(
  teammates: TeammateSummary[],
  chats: ChatSummary[],
): TeammateSummary[] {
  const rank = { waiting: 0, working: 1, paused: 1, queued: 2, idle: 3 } as const;
  const activity = (teammate: TeammateSummary) => teammateStatus(teammate).activity;
  const at = (teammate: TeammateSummary) => conversationWith(teammate, chats)?.lastActivityAt ?? "";
  return [...teammates].sort(
    (a, b) => rank[activity(a)] - rank[activity(b)] || at(b).localeCompare(at(a)),
  );
}

/** Direct chats already show on the roster; this is what happened elsewhere, newest first. */
export function elsewhere(activity: ActivityItem[]): ActivityItem[] {
  return activity.filter((item) => item.chatKind !== "direct").slice(0, RECENT);
}

/** Where a turn happened: the group's name, or what kind of automation started it. */
export function activityPlace(item: ActivityItem): string | null {
  if (item.chatKind === "group") return item.chatTitle;
  switch (item.trigger) {
    case "schedule":
      return "Scheduled";
    case "watch":
      return "Page changed";
    case "webhook":
      return "Webhook";
    case "gmail":
      return "New mail";
    case "calendar":
      return "Event coming up";
    default:
      return null;
  }
}
