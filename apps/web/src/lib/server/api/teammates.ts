import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import {
  bots as teammates,
  CHANNELS,
  chats,
  instructionProposals,
  LOCKS,
  lockUntilCommit,
  notify,
  ownerTimeZone,
  runs,
  schedules,
  triggers,
  type Tx,
} from "@open-bot/db";
import { newTeammateSlot, teammateBundleSchema, toCents } from "@open-bot/domain";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { memoryReady } from "../memory";
import { publish } from "../publish";
import { nextTeammateColor } from "../queries";
import { insertTeammateParts, teammateParts } from "../teammates";
import { worker } from "../worker";
import { ApiError } from "./errors";

type Inputs = ApiInputs["teammates"];
type Outputs = ApiOutputs["teammates"];

/** Take the team lock, then decide where a new teammate goes, as the worker's create does. */
async function claimSlot(tx: Tx, name: string): Promise<{ slug: string; first: boolean }> {
  await lockUntilCommit(tx, LOCKS.team);
  const team = await tx
    .select({ slug: teammates.slug, archivedAt: teammates.archivedAt })
    .from(teammates);
  return newTeammateSlot(team, name);
}

/** A step after the change is saved: if it fails, the change still happened, so it's logged. */
async function afterSaving(step: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.warn(`teammate saved, but ${step} failed`, error);
  }
}

/** Write the teammate's workspace now; before its next run is soon enough if the computer's away. */
export async function syncWorkspace(teammateId: string) {
  await afterSaving("importing its legacy memory", async () =>
    (await memoryReady()).importLegacy(),
  );
  await worker.teammates.sync({ teammateId }).catch(() => {});
}

/** What changing who's on the team refreshes. */
async function publishTeamChanged() {
  await Promise.all([
    publish({ type: "bots" }),
    publish({ type: "skills" }),
    publish({ type: "schedules" }),
    publish({ type: "triggers" }),
    publish({ type: "lessons" }),
  ]);
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
  const [source] = await db
    .select()
    .from(teammates)
    .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
  if (!source) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
  const parts = await teammateParts(teammateId);
  const timezone = await ownerTimeZone(db);

  const created = await db.transaction(async (tx) => {
    const { slug } = await claimSlot(tx, name);
    // Archiving takes the team lock too, so the source is still on the team if it's here now.
    const [still] = await tx
      .select({ id: teammates.id })
      .from(teammates)
      .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
    if (!still) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
    const [copy] = await tx
      .insert(teammates)
      .values({
        name,
        slug,
        role: source.role,
        instructions: source.instructions,
        color: source.color,
        emoji: source.emoji,
        autonomy: source.autonomy,
        isPrimary: false,
      })
      .returning({ id: teammates.id });
    const [chat] = await tx
      .insert(chats)
      .values({ kind: "direct", title: name, botId: copy!.id })
      .returning({ id: chats.id });
    await insertTeammateParts(
      tx,
      copy!.id,
      // Lessons are learned, like memory, so they come along with it.
      { ...parts, lessons: copyMemory ? parts.lessons : [] },
      timezone,
    );
    // Reminders still to come are copied too, paused like the rest.
    const reminders = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.botId, teammateId), eq(schedules.kind, "once")));
    const upcoming = reminders.filter((reminder) => (reminder.runAt?.getTime() ?? 0) > Date.now());
    if (upcoming.length > 0)
      await tx.insert(schedules).values(
        upcoming.map((reminder) => ({
          botId: copy!.id,
          title: reminder.title,
          prompt: reminder.prompt,
          kind: "once" as const,
          runAt: reminder.runAt,
          nextRunAt: reminder.runAt,
          timezone: reminder.timezone,
          enabled: false,
          createdBy: "user" as const,
        })),
      );
    return { teammateId: copy!.id, chatId: chat!.id };
  });

  await syncWorkspace(created.teammateId);
  let memoryCopied = !copyMemory;
  if (copyMemory)
    memoryCopied = await memoryReady()
      .then((memory) => memory.copyBot(source.id, created.teammateId))
      .then(
        () => true,
        () => false,
      );
  await afterSaving("refreshing open pages", publishTeamChanged);
  return { ...created, memoryCopied };
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
  const { teammate, ...parts } = teammateBundleSchema.parse(JSON.parse(file));
  const color = teammate.color ?? (await nextTeammateColor());
  const timezone = await ownerTimeZone(db);

  const created = await db.transaction(async (tx) => {
    const { slug, first } = await claimSlot(tx, teammate.name);
    const [row] = await tx
      .insert(teammates)
      .values({
        name: teammate.name,
        slug,
        role: teammate.role,
        instructions: teammate.instructions,
        color,
        emoji: teammate.emoji,
        autonomy: teammate.autonomy,
        // The first teammate leads.
        isPrimary: first,
      })
      .returning({ id: teammates.id });
    const [chat] = await tx
      .insert(chats)
      .values({ kind: "direct", title: teammate.name, botId: row!.id })
      .returning({ id: chats.id });
    await insertTeammateParts(tx, row!.id, parts, timezone);
    return { teammateId: row!.id, chatId: chat!.id };
  });
  await syncWorkspace(created.teammateId);
  await afterSaving("refreshing open pages", publishTeamChanged);
  return {
    ...created,
    name: teammate.name,
    paused: parts.routines.length + parts.watches.length,
  };
}

export async function setLead({ teammateId }: Inputs["setLead"]): Promise<{ ok: true }> {
  await db.transaction(async (tx) => {
    // Under the team lock nobody else archives or adds a teammate, or picks a lead, meanwhile.
    await lockUntilCommit(tx, LOCKS.team);
    const [lead] = await tx
      .select({ id: teammates.id })
      .from(teammates)
      .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
    if (!lead) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
    // Only the rows that change, so the other teammates keep their revisions.
    const leads = sql`(${teammates.id} = ${teammateId})`;
    await tx
      .update(teammates)
      .set({ isPrimary: leads })
      .where(sql`${teammates.isPrimary} <> ${leads}`);
  });
  await afterSaving("refreshing open pages", () => publish({ type: "bots" }));
  return { ok: true };
}

/**
 * Archive a teammate: its chats are archived, its automations paused and its work stopped, all at
 * once. Its screen stops and its browser history goes; sign-ins stay shared with the other screens.
 */
export async function archiveTeammate({ teammateId }: Inputs["archive"]): Promise<{ ok: true }> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockUntilCommit(tx, LOCKS.team);
    // Its runs before its row, the order a memory write takes them in, so the two can't deadlock.
    await tx
      .update(runs)
      .set({ cancelRequestedAt: now })
      .where(
        and(
          eq(runs.botId, teammateId),
          inArray(runs.status, ["queued", "starting", "running", "waiting"]),
        ),
      );
    await tx
      .update(teammates)
      .set({ archivedAt: now, isPrimary: false })
      .where(eq(teammates.id, teammateId));
    await tx
      .update(chats)
      .set({ archivedAt: now })
      .where(and(eq(chats.botId, teammateId), isNull(chats.archivedAt)));
    await tx.update(schedules).set({ enabled: false }).where(eq(schedules.botId, teammateId));
    await tx.update(triggers).set({ enabled: false }).where(eq(triggers.botId, teammateId));
  });
  await afterSaving("telling the worker to stop its runs", () =>
    notify(pool, CHANNELS.worker, "cancel"),
  );
  await worker.screens.forget({ screenId: teammateId }).catch(() => {});
  await afterSaving("refreshing open pages", () => publish({ type: "bots" }));
  return { ok: true };
}

/** A teammate's monthly budget, or none so it can't pay at all, and what it may buy on its own. */
export async function setBudget({
  teammateId,
  budget,
  autoApprove,
}: Inputs["setBudget"]): Promise<{ ok: true }> {
  const budgetCents = budget === null ? null : toCents(budget);
  if (budget !== null && budgetCents === null)
    throw new ApiError("BAD_REQUEST", "Give the budget in dollars, like 100.");
  const autoApproveCents = toCents(autoApprove) ?? 0;
  if (budgetCents !== null && autoApproveCents > budgetCents)
    throw new ApiError(
      "BAD_REQUEST",
      "The amount to approve on its own can't be more than the budget.",
    );
  const [updated] = await db
    .update(teammates)
    .set({ monthlyBudgetCents: budgetCents, autoApproveCents })
    .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)))
    .returning({ id: teammates.id });
  if (!updated) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
  await afterSaving("refreshing open pages", () => publish({ type: "purchases" }));
  return { ok: true };
}

/** The teammate a suggestion is for, under the column's legacy name. */
const suggestedFor = instructionProposals.botId; // vocabulary: allow

/**
 * Decide a suggestion that's still waiting. Null when it was already decided the same way; one
 * decided the other way is a conflict.
 */
async function decideProposal(tx: Tx, proposalId: string, status: "accepted" | "dismissed") {
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
  if (!decided) throw new ApiError("NOT_FOUND", "That suggestion is gone.");
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
  throw new ApiError(
    "STATE_CONFLICT",
    newer ? "A newer suggestion replaced this one." : "That suggestion was already handled.",
  );
}

/** Take a teammate's suggested instructions; they apply from its next message. */
export async function acceptProposal({
  proposalId,
}: ApiInputs["proposals"]["accept"]): Promise<{ ok: true }> {
  const teammateId = await db.transaction(async (tx) => {
    const proposal = await decideProposal(tx, proposalId, "accepted");
    if (!proposal) return null;
    await tx
      .update(teammates)
      .set({ instructions: proposal.proposed })
      .where(eq(teammates.id, proposal.teammateId));
    return proposal.teammateId;
  });
  if (teammateId) await syncWorkspace(teammateId);
  await afterSaving("refreshing open pages", () => publish({ type: "bots" }));
  return { ok: true };
}

export async function dismissProposal({
  proposalId,
}: ApiInputs["proposals"]["dismiss"]): Promise<{ ok: true }> {
  await db.transaction((tx) => decideProposal(tx, proposalId, "dismissed"));
  await afterSaving("refreshing open pages", () => publish({ type: "bots" }));
  return { ok: true };
}
