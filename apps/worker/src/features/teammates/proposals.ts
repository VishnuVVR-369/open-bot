// Instructions a teammate suggests for itself: saving a suggestion and deciding one.
// The only writer of `instruction_proposals`.
import { instructionProposals, type Tx } from "@open-bot/db";
import { and, eq, gt } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { TeammateError } from "./errors";

/** The teammate a suggestion is for, under the column's legacy name. */
export const suggestedFor = instructionProposals.teammateId;

/**
 * Decide a suggestion that's still waiting. Null when it was already decided the same way; one
 * decided the other way is a conflict.
 */
export async function decideProposal(tx: Tx, proposalId: string, status: "accepted" | "dismissed") {
  const [proposal] = await tx
    .update(instructionProposals)
    .set({ status, decidedAt: new Date() })
    .where(and(eq(instructionProposals.id, proposalId), eq(instructionProposals.status, "pending")))
    .returning({ teammateId: suggestedFor, proposed: instructionProposals.proposed });
  if (proposal) return proposal;
  const [decided] = await tx
    .select({
      status: instructionProposals.status,
      teammateId: suggestedFor,
      createdAt: instructionProposals.createdAt,
    })
    .from(instructionProposals)
    .where(eq(instructionProposals.id, proposalId));
  if (!decided) throw new TeammateError(404, "That suggestion is gone.");
  if (decided.status === status) return null;
  // A teammate's newer suggestion dismisses the one waiting; that isn't something you did.
  const [newer] =
    decided.status === "dismissed"
      ? await tx
          .select({ id: instructionProposals.id })
          .from(instructionProposals)
          .where(
            and(
              eq(suggestedFor, decided.teammateId),
              gt(instructionProposals.createdAt, decided.createdAt),
            ),
          )
          .limit(1)
      : [];
  throw new TeammateError(
    409,
    newer ? "A newer suggestion replaced this one." : "That suggestion was already handled.",
  );
}

/** A suggestion a teammate makes for its own instructions. */
export type InstructionProposalInput = {
  teammateId: string;
  current: string;
  proposed: string;
  reason: string;
  runId: string;
};

export async function addProposal(ctx: Context, input: InstructionProposalInput): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(instructionProposals)
      .set({ status: "dismissed", decidedAt: new Date() })
      .where(and(eq(suggestedFor, input.teammateId), eq(instructionProposals.status, "pending")));
    await tx.insert(instructionProposals).values({
      teammateId: input.teammateId,
      current: input.current,
      proposed: input.proposed,
      reason: input.reason,
      runId: input.runId,
    });
  });
  await publishApp(ctx, { type: "teammates" });
}
