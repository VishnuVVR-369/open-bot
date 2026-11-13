import "server-only";
import { approvals, bots, instructionProposals, notifications } from "@open-bot/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Attention } from "@open-bot/api";
import { listTakeoverRequests } from "@/features/computer/server";
import { db } from "@/lib/server/db";

/** What needs you, for the badges on every screen and on the phone's Home. */
export async function getAttention(): Promise<Attention> {
  const [[pending], takeoverRequests, proposals, [unread]] = await Promise.all([
    db.select({ value: count() }).from(approvals).where(eq(approvals.status, "pending")),
    listTakeoverRequests(),
    db
      .select({ id: instructionProposals.id, botId: instructionProposals.botId })
      .from(instructionProposals)
      .innerJoin(bots, eq(bots.id, instructionProposals.botId))
      .where(and(eq(instructionProposals.status, "pending"), isNull(bots.archivedAt)))
      .orderBy(desc(instructionProposals.createdAt)),
    db.select({ value: count() }).from(notifications).where(isNull(notifications.readAt)),
  ]);
  return {
    pendingApprovals: pending?.value ?? 0,
    takeoverRequests,
    proposals,
    unreadNotifications: unread?.value ?? 0,
  };
}
