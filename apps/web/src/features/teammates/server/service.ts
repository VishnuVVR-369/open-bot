import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import {
  approvalRules,
  bots,
  chats,
  configurationRevision,
  instructionProposals,
  lessons,
  purchases,
  runs,
  vaultItems,
} from "@open-bot/db";
import {
  monthStart,
  nextTeammateColor,
  SPENDING_PURCHASE_STATUSES,
  teammateBundleSchema,
} from "@open-bot/domain";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";
import type { LessonView, ProposalView, PurchaseView, SpendingView } from "@/lib/types";

/**
 * The owner's changes to teammates. The worker's teammate service makes them (it owns the
 * teammate tables, see packages/db/src/owners.ts); this checks what the owner sent and passes it on.
 * The reads after them are for a teammate's page and its tabs.
 */

type Inputs = ApiInputs["teammates"];
type Outputs = ApiOutputs["teammates"];

/** Write the teammate's workspace now; before its next run is soon enough if the computer's away. */
export async function syncWorkspace(teammateId: string) {
  await worker.teammates.sync({ teammateId }).catch(() => {});
}

export async function createTeammate({
  profile,
  templateId,
  starterIds,
}: Inputs["create"]): Promise<Outputs["create"]> {
  return worker.teammates.create({
    ...profile,
    template_id: templateId ?? undefined,
    starter_ids: starterIds,
  });
}

export async function updateTeammate({
  teammateId,
  profile,
  revision,
}: Inputs["update"]): Promise<Outputs["update"]> {
  return worker.teammates.update({ teammateId, changes: profile, expected_revision: revision });
}

export async function duplicateTeammate({
  teammateId,
  name,
  copyMemory,
}: Inputs["duplicate"]): Promise<Outputs["duplicate"]> {
  return worker.teammates.duplicate({ teammateId, name, copyMemory });
}

/** The first thing wrong with an exported file, in words. */
function bundleProblem(file: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(file);
  } catch {
    return "This isn't an open-bot teammate file.";
  }
  const parsed = teammateBundleSchema.safeParse(json);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return issue?.path.length
    ? `The file has a problem at ${issue.path.join(".")}: ${issue.message}`
    : (issue?.message ?? "The file couldn't be read.");
}

export async function importTeammate({ file }: Inputs["import"]): Promise<Outputs["import"]> {
  const problem = bundleProblem(file);
  if (problem) throw new ApiError("BAD_REQUEST", problem);
  return worker.teammates.import({ bundle: teammateBundleSchema.parse(JSON.parse(file)) });
}

export async function setLead({ teammateId }: Inputs["setLead"]): Promise<{ ok: true }> {
  return worker.teammates.setLead({ teammateId });
}

/**
 * Archive a teammate: its chats are archived, its automations paused and its work stopped, all at
 * once. Its screen stops and its browser history goes; sign-ins stay shared with the other screens.
 */
export async function archiveTeammate({ teammateId }: Inputs["archive"]): Promise<{ ok: true }> {
  return worker.teammates.archive({ teammateId });
}

/** A teammate's monthly budget, or none so it can't pay at all, and what it may buy on its own. */
export async function setBudget(input: Inputs["setBudget"]): Promise<{ ok: true }> {
  return worker.teammates.setBudget(input);
}

/** Take a teammate's suggested instructions; they apply from its next message. */
export async function acceptProposal({
  proposalId,
}: ApiInputs["proposals"]["accept"]): Promise<{ ok: true }> {
  return worker.proposals.accept({ proposalId });
}

export async function dismissProposal({
  proposalId,
}: ApiInputs["proposals"]["dismiss"]): Promise<{ ok: true }> {
  return worker.proposals.dismiss({ proposalId });
}

/** The color a new teammate starts with: the one the team uses least, as the worker picks. */
export async function nextColor(): Promise<string> {
  const rows = await db.select({ color: bots.color }).from(bots).where(isNull(bots.archivedAt));
  return nextTeammateColor(rows.map((row) => row.color));
}

/** A teammate's page: its profile, its chats, a suggestion waiting for you, and its rules. */
export type TeammatePage = NonNullable<Awaited<ReturnType<typeof getTeammatePage>>>;

export async function getTeammatePage(teammateId: string) {
  const [teammate] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, teammateId), isNull(bots.archivedAt)));
  if (!teammate) return null;
  const [teammateChats, proposal, rules] = await Promise.all([
    db
      .select({
        id: chats.id,
        kind: chats.kind,
        title: chats.title,
        main: chats.main,
        lastActivityAt: chats.lastActivityAt,
      })
      .from(chats)
      .where(and(eq(chats.botId, teammateId), isNull(chats.archivedAt), ne(chats.kind, "helper")))
      .orderBy(desc(chats.lastActivityAt)),
    pendingProposal(teammateId),
    db
      .select({ id: approvalRules.id, kind: approvalRules.kind, pattern: approvalRules.pattern })
      .from(approvalRules)
      .where(eq(approvalRules.botId, teammateId))
      .orderBy(asc(approvalRules.createdAt)),
  ]);
  return {
    bot: teammate,
    // What the form sends back with a save, so a save over a newer change is refused.
    revision: configurationRevision(teammate),
    chats: teammateChats.map((chat) => ({
      ...chat,
      lastActivityAt: chat.lastActivityAt.toISOString(),
    })),
    proposal,
    rules,
  };
}

/** A teammate's name, for the page title, or null if there's none by that id. */
export async function teammateName(teammateId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(teammateId)) return null;
  const [row] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, teammateId));
  return row?.name ?? null;
}

async function pendingProposal(botId: string): Promise<ProposalView | null> {
  const [row] = await db
    .select()
    .from(instructionProposals)
    .where(and(eq(instructionProposals.botId, botId), eq(instructionProposals.status, "pending")))
    .orderBy(desc(instructionProposals.createdAt))
    .limit(1);
  return row
    ? {
        id: row.id,
        current: row.current,
        proposed: row.proposed,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

export async function listLessons(botId: string): Promise<LessonView[]> {
  const rows = await db
    .select({ lesson: lessons, chatId: runs.chatId })
    .from(lessons)
    .leftJoin(runs, eq(runs.id, lessons.runId))
    .where(eq(lessons.botId, botId))
    .orderBy(desc(lessons.createdAt));
  return rows.map(({ lesson, chatId }) => ({
    id: lesson.id,
    text: lesson.text,
    createdAt: lesson.createdAt.toISOString(),
    runId: lesson.runId,
    chatId,
  }));
}

export async function getSpending(botId: string): Promise<SpendingView | null> {
  const [bot] = await db
    .select({ budget: bots.monthlyBudgetCents, autoApprove: bots.autoApproveCents })
    .from(bots)
    .where(eq(bots.id, botId));
  if (!bot) return null;
  const [rows, [spent]] = await Promise.all([
    db
      .select({
        purchase: purchases,
        cardName: vaultItems.name,
        cardHint: vaultItems.hint,
      })
      .from(purchases)
      .leftJoin(vaultItems, eq(vaultItems.id, purchases.cardId))
      .where(eq(purchases.botId, botId))
      .orderBy(desc(purchases.createdAt))
      .limit(50),
    db
      .select({ total: sql<number>`coalesce(sum(${purchases.amountCents}), 0)::int` })
      .from(purchases)
      .where(
        and(
          eq(purchases.botId, botId),
          inArray(purchases.status, [...SPENDING_PURCHASE_STATUSES]),
          gte(purchases.createdAt, monthStart()),
        ),
      ),
  ]);
  return {
    budgetCents: bot.budget,
    autoApproveCents: bot.autoApprove,
    spentCents: spent?.total ?? 0,
    purchases: rows.map(({ purchase, cardName, cardHint }): PurchaseView => ({
      id: purchase.id,
      botId: purchase.botId,
      card: cardName ? `${cardName} (${cardHint})` : null,
      amountCents: purchase.amountCents,
      merchant: purchase.merchant,
      description: purchase.description,
      status: purchase.status,
      note: purchase.note,
      chatId: purchase.chatId,
      runId: purchase.runId,
      createdAt: purchase.createdAt.toISOString(),
    })),
  };
}
