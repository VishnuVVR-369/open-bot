import "server-only";
import type { ApiInputs, Home } from "@open-bot/api";
import { approvals, bots, instructionProposals, notifications } from "@open-bot/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { listActivity, listFinishedSince, listTakeoverRequests } from "../queries";

/** Home on the phone: what needs you, what you missed, and what teammates did lately. */
export async function getHome(
  user: { name: string },
  { awaySince }: ApiInputs["home"]["get"],
): Promise<Home> {
  const [[pending], requests, proposals, [unread], briefing, activity] = await Promise.all([
    db.select({ value: count() }).from(approvals).where(eq(approvals.status, "pending")),
    listTakeoverRequests(),
    db
      .select({ id: instructionProposals.id, botId: instructionProposals.botId })
      .from(instructionProposals)
      .innerJoin(bots, eq(bots.id, instructionProposals.botId))
      .where(and(eq(instructionProposals.status, "pending"), isNull(bots.archivedAt)))
      .orderBy(desc(instructionProposals.createdAt)),
    db.select({ value: count() }).from(notifications).where(isNull(notifications.readAt)),
    awaySince ? listFinishedSince(new Date(awaySince)) : Promise.resolve([]),
    listActivity(),
  ]);
  return {
    user: { name: user.name },
    pendingApprovals: pending?.value ?? 0,
    takeoverRequests: requests,
    proposals,
    unreadNotifications: unread?.value ?? 0,
    briefing,
    activity,
  };
}
