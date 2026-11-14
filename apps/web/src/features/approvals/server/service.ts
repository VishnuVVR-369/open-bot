import "server-only";
import type { ApiInputs, ApprovalRule, ApprovalView } from "@open-bot/api";
import { approvalRules, approvals, teammates } from "@open-bot/db";
import type { ApprovalStatus } from "@open-bot/domain";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { toApprovalView } from "./views";
import { worker } from "@/lib/server/worker";
import { ApiError } from "@/lib/server/api/errors";

const OUTCOME: Record<Exclude<ApprovalStatus, "pending">, string> = {
  approved: "This was already approved.",
  denied: "This was already denied.",
  expired: "This expired before it was decided.",
};

export async function getApproval(approvalId: string): Promise<ApprovalView> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!row) throw new ApiError("NOT_FOUND", "That approval is gone.");
  return toApprovalView(row);
}

/**
 * Approve or deny. Idempotent by its state: deciding the same way again succeeds, and anything
 * else that already happened (decided differently elsewhere, or expired) is `ALREADY_DECIDED`.
 */
export async function decideApproval(
  input: ApiInputs["approvals"]["decide"],
): Promise<{ status: ApprovalStatus }> {
  const { status } = await worker.approvals.decide(input);
  if (status === input.decision) return { status };
  if (status === "pending") throw new Error("The approval couldn't be decided. Try again.");
  throw new ApiError("ALREADY_DECIDED", OUTCOME[status], { status });
}

/** What each teammate may do without asking, oldest first. */
export async function listApprovalRules(): Promise<ApprovalRule[]> {
  const rows = await db
    .select({ rule: approvalRules })
    .from(approvalRules)
    .innerJoin(teammates, eq(teammates.id, approvalRules.teammateId))
    .where(isNull(teammates.archivedAt))
    .orderBy(asc(approvalRules.createdAt));
  return rows.map(({ rule }) => ({
    id: rule.id,
    teammateId: rule.teammateId,
    kind: rule.kind,
    pattern: rule.pattern,
    createdAt: rule.createdAt.toISOString(),
  }));
}

export async function removeApprovalRule({ ruleId }: ApiInputs["approvals"]["removeRule"]) {
  await worker.approvals.removeRule({ ruleId });
  return { ok: true as const };
}

/** Waiting approvals first, then the latest decided ones, newest first. */
export async function listApprovals(): Promise<ApprovalView[]> {
  const rows = await db
    .select()
    .from(approvals)
    .orderBy(
      sql`case when ${approvals.status} = 'pending' then 0 else 1 end`,
      desc(approvals.createdAt),
    )
    .limit(100);
  return rows.map(toApprovalView);
}
