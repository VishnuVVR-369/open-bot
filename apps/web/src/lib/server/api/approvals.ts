import "server-only";
import type { ApiInputs, ApprovalStatus, ApprovalView } from "@open-bot/api";
import { approvals } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { toApprovalView } from "../views";
import { worker } from "../worker";
import { ApiError } from "./errors";

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
  const { status } = await worker<{ decided: boolean; status: ApprovalStatus }>(
    "POST",
    `/internal/approvals/${input.approvalId}/decide`,
    { decision: input.decision, alwaysAllow: input.alwaysAllow },
  );
  if (status === input.decision) return { status };
  if (status === "pending") throw new Error("The approval couldn't be decided. Try again.");
  throw new ApiError("ALREADY_DECIDED", OUTCOME[status], { status });
}
