import {
  teammates,
  chatMembers,
  configurationRevision,
  LOCKS,
  lockUntilCommit,
  notify,
  ownerTimeZone,
  type Queryable,
  chats,
  schedules,
  teammateCopies,
  teammateRevision,
  triggers,
} from "@open-bot/db";
import {
  teammateCreation,
  type TeammateCreationPlan,
  type TeammateProfile,
  teammateProfileChangesSchema,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type CreateTeammateInput,
  type CreatedTeammate,
  newTeammateSlot,
  nextTeammateColor,
  NOTIFY_CHANNELS,
  TEAMMATE_TEMPLATES,
  type TeammateBundle,
  toCents,
} from "@open-bot/domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { errorMessage } from "../../logger";
import type { Teammate } from "../../core/db-types";
import { requestTeammateRunsCancel } from "../../runs/cancel";
import { addApprovalRules } from "../approvals";
import { addChat, archiveChatsOf, renameDirectChats, shownMainChats } from "../chat";
import {
  addPausedRoutines,
  addPausedWatches,
  copyUpcomingReminders,
  pauseSchedulesOf,
  pauseTriggersOf,
  type ScheduleService,
} from "../automations";
import { addTeammateSkills, type SkillService } from "../skills";
import { type MemoryService } from "@open-bot/memory";
import { assignConnection, connectionSummaries, type ConnectionSummary } from "./connections";
import { TeammateError } from "./errors";
import { teammateParts, type TeammateParts } from "./parts";
import {
  addProposal,
  checkReviewed,
  decideProposal,
  type InstructionProposalInput,
} from "./proposals";

/** A copy of a teammate: which one it was made from, and whether its memory came along. */
type CopyRecord = typeof teammateCopies.$inferSelect;

const COPY_ID_TAKEN = "That id is already another teammate's. Duplicate again with a new one.";

/**
 * The copy of `from` made under `copyId` by an earlier ask, with its chat, or null if there's
 * none yet. An id another teammate has, or a copy of someone else, is refused.
 */
async function madeCopy(
  tx: Queryable,
  copyId: string,
  from: string,
): Promise<{ teammate: Teammate; chatId: string; copy: CopyRecord } | null> {
  const [row] = await tx
    .select({ teammate: teammates, copy: teammateCopies })
    .from(teammates)
    .leftJoin(teammateCopies, eq(teammateCopies.teammateId, teammates.id))
    .where(eq(teammates.id, copyId));
  if (!row) return null;
  if (row.copy?.sourceId !== from) throw new TeammateError(409, COPY_ID_TAKEN);
  if (row.teammate.archivedAt)
    throw new TeammateError(404, "That copy was made, and has been archived since.");
  // Its main chat, or the direct chat that took that role over when it was archived.
  const [chat] = await tx
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.teammateId, copyId), eq(chats.kind, "direct")))
    .orderBy(desc(chats.main), asc(chats.createdAt))
    .limit(1);
  if (!chat) throw new TeammateError(404, "That copy has no chat any more.");
  return { teammate: row.teammate, chatId: chat.id, copy: row.copy };
}

/** The memory a new teammate can start with. */
export type TeammateMemory = Pick<MemoryService, "copyTeammate" | "addLessons">;

/** Teammates on the team now, oldest first; with `inChat`, only that group chat's members. */
export async function activeTeammates(
  db: Queryable,
  { inChat }: { inChat?: string } = {},
): Promise<{ id: string; name: string; slug: string }[]> {
  const columns = { id: teammates.id, name: teammates.name, slug: teammates.slug };
  if (!inChat)
    return db
      .select(columns)
      .from(teammates)
      .where(isNull(teammates.archivedAt))
      .orderBy(asc(teammates.createdAt));
  return db
    .select(columns)
    .from(chatMembers)
    .innerJoin(teammates, eq(teammates.id, chatMembers.teammateId))
    .where(and(eq(chatMembers.chatId, inChat), isNull(teammates.archivedAt)))
    .orderBy(asc(teammates.createdAt));
}

export type CreatedBy = { kind: "user" } | { kind: "teammate"; teammateId: string; runId: string };

/**
 * Creating and editing teammates, for the web app and for teammates' own tools alike. Edits use
 * an optimistic revision, so nobody silently overwrites a change made since they read it.
 */
export class TeammateService {
  constructor(
    private readonly ctx: Context,
    private readonly schedules: ScheduleService,
    private readonly skills: SkillService,
    private readonly memory: TeammateMemory,
    private readonly syncWorkspace: (teammate: Teammate) => Promise<void>,
  ) {}

  /** A teammate's revision: its profile, so other changes to it don't refuse an edit. */
  static revision(teammate: Teammate): string {
    return teammateRevision(teammate);
  }

  /**
   * Whether an edit made from `revision` is still current. A revision of the whole row, as the
   * worker handed out before revisions covered only the profile, still counts while it matches,
   * so a web app or a teammate's thread from before then isn't refused at every save.
   *
   * TODO(2026-11-28): drop the whole-row check once every deployed web app hands out profile
   * revisions (the release after "teammates on the phone") and a week has passed since, so open
   * web forms and teammates' threads have read the teammate again.
   */
  static isCurrent(teammate: Teammate, revision: string): boolean {
    return (
      TeammateService.revision(teammate) === revision ||
      configurationRevision(teammate) === revision
    );
  }

  templates() {
    return TEAMMATE_TEMPLATES;
  }

  /** The teammate, unless it was deleted or archived. */
  async requireTeammate(id: string): Promise<Teammate> {
    const [teammate] = await this.ctx.db
      .select()
      .from(teammates)
      .where(and(eq(teammates.id, id), isNull(teammates.archivedAt)));
    if (!teammate) throw new TeammateError(404, "That teammate no longer exists or is archived.");
    return teammate;
  }

  /** A teammate, archived or not: an archived one's screen and workspace are still cleaned up. */
  async findTeammate(id: string): Promise<Teammate> {
    const [teammate] = await this.ctx.db.select().from(teammates).where(eq(teammates.id, id));
    if (!teammate) throw new TeammateError(404, "No such teammate.");
    return teammate;
  }

  async list() {
    const rows = await this.ctx.db
      .select({
        id: teammates.id,
        name: teammates.name,
        role: teammates.role,
        emoji: teammates.emoji,
        autonomy: teammates.autonomy,
      })
      .from(teammates)
      .where(isNull(teammates.archivedAt))
      .orderBy(asc(teammates.createdAt));
    const mainChats = await shownMainChats(this.ctx.db);
    return rows.map((row) => {
      const chatId = mainChats.get(row.id);
      return { ...row, chatPath: chatId ? `/chats/${chatId}` : null };
    });
  }

  /** A teammate's whole setup: profile, skills, automations and the connections it can use. */
  async get(id: string) {
    const teammate = await this.requireTeammate(id);
    const [skills, routines, watches, services, mainChats] = await Promise.all([
      this.skills.forTeammate(id),
      this.ctx.db
        .select({
          id: schedules.id,
          kind: schedules.kind,
          title: schedules.title,
          prompt: schedules.prompt,
          cron: schedules.cron,
          runAt: schedules.runAt,
          timezone: schedules.timezone,
          enabled: schedules.enabled,
          quiet: schedules.quiet,
          nextRunAt: schedules.nextRunAt,
        })
        .from(schedules)
        .where(eq(schedules.teammateId, id)),
      this.ctx.db
        .select({
          id: triggers.id,
          kind: triggers.kind,
          title: triggers.title,
          prompt: triggers.prompt,
          enabled: triggers.enabled,
          url: triggers.url,
          intervalMinutes: triggers.intervalMinutes,
          lookFor: triggers.lookFor,
        })
        .from(triggers)
        .where(eq(triggers.teammateId, id)),
      this.listConnections(),
      shownMainChats(this.ctx.db, [id]),
    ]);
    const mainChatId = mainChats.get(id);
    return {
      id: teammate.id,
      name: teammate.name,
      role: teammate.role,
      instructions: teammate.instructions,
      color: teammate.color,
      emoji: teammate.emoji,
      autonomy: teammate.autonomy,
      revision: TeammateService.revision(teammate),
      chatPath: mainChatId ? `/chats/${mainChatId}` : null,
      skills: skills.map(({ id, name, description, instructions, teammateId }) => ({
        id,
        name,
        description,
        instructions,
        sharedWithEveryone: teammateId === null,
      })),
      schedules: routines,
      triggers: watches,
      connections: services.filter(
        (service) =>
          service.enabled && (service.teammateIds === null || service.teammateIds.includes(id)),
      ),
    };
  }

  /** The color the team uses least, so teammates created in a row don't all look the same. */
  private async nextColor(): Promise<string> {
    const used = await this.ctx.db
      .select({ color: teammates.color })
      .from(teammates)
      .where(isNull(teammates.archivedAt));
    return nextTeammateColor(used.map((row) => row.color));
  }

  /** Resolves a request into what will be created, so it can be shown before anything is. */
  async plan(input: CreateTeammateInput): Promise<TeammateCreationPlan> {
    return teammateCreation(input, await this.nextColor());
  }

  /** Checks a plan's schedules, so an approval is never asked for one that can't be saved. */
  async checkPlan(plan: TeammateCreationPlan): Promise<void> {
    for (const schedule of plan.schedules) {
      try {
        await this.schedules.check({ ...schedule, timezone: null });
      } catch (error) {
        throw new TeammateError(400, `Schedule "${schedule.title}": ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Creates the teammate and its direct chat, then its skills and schedules. The teammate exists
   * even when one of those fails; the failures are reported so they can be added afterwards.
   */
  async create(
    input: CreateTeammateInput | TeammateCreationPlan,
    by: CreatedBy = { kind: "user" },
  ): Promise<CreatedTeammate> {
    const plan = "profile" in input ? input : await this.plan(input);
    const { profile } = plan;
    const created = await this.ctx.db.transaction(async (tx) => {
      await lockUntilCommit(tx, LOCKS.team);
      const team = await tx
        .select({ slug: teammates.slug, archivedAt: teammates.archivedAt })
        .from(teammates);
      const { slug, first } = newTeammateSlot(team, profile.name);
      const [teammate] = await tx
        .insert(teammates)
        .values({ ...profile, slug, isLead: first })
        .returning();
      const chatId = await addChat(tx, {
        kind: "direct",
        title: profile.name,
        teammateId: teammate!.id,
        main: true,
      });
      return { teammate: teammate!, chatId };
    });
    const teammateId = created.teammate.id;
    const failed: CreatedTeammate["failed"] = [];
    const timezone = await ownerTimeZone(this.ctx.db);
    for (const schedule of plan.schedules) {
      await this.schedules
        .create({
          teammateId,
          ...schedule,
          timezone,
          createdBy: by.kind,
          createdByRunId: by.kind === "teammate" ? by.runId : null,
        })
        .catch((error: unknown) =>
          failed.push({ kind: "schedule", name: schedule.title, error: errorMessage(error) }),
        );
    }
    for (const skill of plan.skills) {
      await this.skills
        .save(
          { ...skill, teammateId },
          by.kind === "teammate" ? { kind: "teammate", teammateId: by.teammateId } : by,
        )
        .catch((error: unknown) =>
          failed.push({ kind: "skill", name: skill.name, error: errorMessage(error) }),
        );
    }
    const workspaceSynced = await this.sync(created.teammate);
    await publishApp(this.ctx, { type: "teammates" });
    await publishApp(this.ctx, { type: "chats" });
    return {
      teammateId,
      name: created.teammate.name,
      chatId: created.chatId,
      chatPath: `/chats/${created.chatId}`,
      revision: TeammateService.revision(created.teammate),
      skills: plan.skills.length - failed.filter((entry) => entry.kind === "skill").length,
      schedules: plan.schedules.length - failed.filter((entry) => entry.kind === "schedule").length,
      failed,
      workspaceSynced,
    };
  }

  /**
   * Changes only the given profile fields. With `expectedRevision`, the edit is refused when the
   * teammate changed since it was read.
   */
  async update(id: string, changes: Partial<TeammateProfile>, expectedRevision?: string) {
    const parsed = teammateProfileChangesSchema.safeParse(changes);
    if (!parsed.success) throw new TeammateError(400, parsed.error.issues[0]!.message);
    const patch = parsed.data;
    const updated = await this.ctx.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(teammates)
        .where(and(eq(teammates.id, id), isNull(teammates.archivedAt)))
        .for("update");
      if (!current) throw new TeammateError(404, "That teammate no longer exists or is archived.");
      if (expectedRevision && !TeammateService.isCurrent(current, expectedRevision))
        throw new TeammateError(
          409,
          "This teammate was changed since it was loaded. Reload it and try again.",
        );
      const [teammate] = await tx
        .update(teammates)
        .set(patch)
        .where(eq(teammates.id, id))
        .returning();
      if (patch.name !== undefined) await renameDirectChats(tx, id, patch.name);
      return teammate!;
    });
    const workspaceSynced = await this.sync(updated);
    await publishApp(this.ctx, { type: "teammates" });
    if (patch.name !== undefined) await publishApp(this.ctx, { type: "chats" });
    return { teammateId: id, revision: TeammateService.revision(updated), workspaceSynced };
  }

  /** The teammate as a file: its profile and parts, to keep or import elsewhere. */
  async exportBundle(id: string): Promise<{ slug: string; bundle: TeammateBundle }> {
    const teammate = await this.requireTeammate(id);
    const { name, role, instructions, emoji, color, autonomy } = teammate;
    return {
      slug: teammate.slug,
      bundle: {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        teammate: { name, role, instructions, emoji, color, autonomy },
        ...(await teammateParts(this.ctx.db, id)),
      },
    };
  }

  /**
   * Adds a teammate with this profile and these parts, with its direct chat, in one transaction:
   * routines and watches start paused, so nothing runs twice or by surprise. A copy's original
   * (`copy.from`) is still on the team when the copy is made, or the copy is refused. A copy asked
   * for under an id (`copy.id`) that a copy of the same original already has is that copy, made
   * by an earlier ask whose answer was lost: it's answered with, and nothing is added.
   */
  private async addTeammate(
    profile: Pick<Teammate, "name" | "role" | "instructions" | "color" | "emoji" | "autonomy">,
    parts: TeammateParts,
    copy?: { from: string; id?: string; copyMemory: boolean },
  ): Promise<{ teammate: Teammate; chatId: string; copy?: CopyRecord }> {
    const timezone = await ownerTimeZone(this.ctx.db);
    // Its lessons live in memory: saved in the same transaction as the rest.
    return this.ctx.db.transaction(async (tx) => {
      await lockUntilCommit(tx, LOCKS.team);
      // Under the team lock, so an ask sent again while the first is still adding the copy waits
      // for it and finds it here.
      if (copy?.id) {
        const made = await madeCopy(tx, copy.id, copy.from);
        if (made) return made;
      }
      const team = await tx
        .select({ id: teammates.id, slug: teammates.slug, archivedAt: teammates.archivedAt })
        .from(teammates);
      // Archiving takes the team lock too, so the original is still on the team if it's here now.
      if (copy && !team.some((row) => row.id === copy.from && !row.archivedAt))
        throw new TeammateError(404, "That teammate no longer exists.");
      const { slug, first } = newTeammateSlot(team, profile.name);
      const [teammate] = await tx
        .insert(teammates)
        .values({ ...profile, ...(copy?.id ? { id: copy.id } : {}), slug, isLead: first })
        .returning();
      const id = teammate!.id;
      const chatId = await addChat(tx, {
        kind: "direct",
        title: profile.name,
        teammateId: id,
        main: true,
      });
      await addTeammateSkills(tx, id, parts.skills);
      await addPausedRoutines(tx, id, parts.routines, timezone);
      await addPausedWatches(tx, id, parts.watches);
      await addApprovalRules(tx, id, parts.allowed);
      if (copy) await copyUpcomingReminders(tx, copy.from, id);
      await this.memory.addLessons(id, parts.lessons, tx);
      if (!copy) return { teammate: teammate!, chatId };
      const [record] = await tx
        .insert(teammateCopies)
        .values({ teammateId: id, sourceId: copy.from, copyMemory: copy.copyMemory })
        .returning();
      return { teammate: teammate!, chatId, copy: record! };
    });
  }

  /** After a teammate is added: its workspace, and the pages that list it. */
  private async welcome(teammate: Teammate) {
    await this.sync(teammate);
    for (const type of [
      "teammates",
      "chats",
      "skills",
      "schedules",
      "triggers",
      "lessons",
    ] as const)
      await publishApp(this.ctx, { type });
  }

  /**
   * A new teammate set up like another: the same job, instructions and carefulness, its own copies
   * of the skills and approval rules, and the routines, page watches and reminders still to come,
   * paused. Memory and lessons come along with `copyMemory`.
   *
   * `copyId` is the id the copy is made under, chosen by the app before asking, so asking again
   * after a lost answer is safe: it answers with the copy the first ask made, as that ask chose
   * it (its name, and whether memory comes along), and finishes what that ask may not have (its
   * memory, its workspace). An id that's another teammate's, or a copy of someone else's, is
   * refused. Without one (an app from before it), every ask makes a new copy.
   */
  async duplicate(id: string, name: string, copyMemory: boolean, copyId?: string) {
    if (copyId === id) throw new TeammateError(409, COPY_ID_TAKEN);
    // An ask sent again may find its original archived since: the copy it made still answers.
    const source = await (copyId ? this.findTeammate(id) : this.requireTeammate(id));
    const { lessons: learned, ...parts } = await teammateParts(this.ctx.db, id);
    const { role, instructions, color, emoji, autonomy } = source;
    const created = await this.addTeammate(
      { name, role, instructions, color, emoji, autonomy },
      { ...parts, lessons: copyMemory ? learned : [] },
      { from: id, id: copyId, copyMemory },
    );
    const copy = created.copy!;
    // Copied again on a retry until it once worked: the copy skips what the new teammate already
    // holds, under both teammates' memory locks, so a retry racing the first ask adds nothing twice.
    let memoryCopied = !copy.copyMemory || copy.memoryCopiedAt !== null;
    if (!memoryCopied) memoryCopied = await this.copyMemory(id, copy.teammateId);
    await this.welcome(created.teammate);
    return { teammateId: created.teammate.id, chatId: created.chatId, memoryCopied };
  }

  /** Copies a teammate's memory to its copy, and notes it did; false if it couldn't. */
  private async copyMemory(from: string, to: string): Promise<boolean> {
    try {
      await this.memory.copyTeammate(from, to);
      await this.ctx.db
        .update(teammateCopies)
        .set({ memoryCopiedAt: new Date() })
        .where(eq(teammateCopies.teammateId, to));
      return true;
    } catch (error) {
      this.ctx.log.warn("teammate copied, but its memory wasn't", {
        teammateId: to,
        error: errorMessage(error),
      });
      return false;
    }
  }

  /** A new teammate from an exported file; its routines and page watches start paused. */
  async importBundle(bundle: TeammateBundle) {
    const { teammate, ...parts } = bundle;
    const created = await this.addTeammate(
      { ...teammate, color: teammate.color ?? (await this.nextColor()) },
      parts,
    );
    await this.welcome(created.teammate);
    return {
      teammateId: created.teammate.id,
      chatId: created.chatId,
      name: created.teammate.name,
      paused: parts.routines.length + parts.watches.length,
    };
  }

  /** Makes this teammate the lead, who answers group chats when nobody is mentioned. */
  async setLead(id: string): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      // Under the team lock nobody else archives or adds a teammate, or picks a lead, meanwhile.
      await lockUntilCommit(tx, LOCKS.team);
      const [lead] = await tx
        .select({ id: teammates.id })
        .from(teammates)
        .where(and(eq(teammates.id, id), isNull(teammates.archivedAt)));
      if (!lead) throw new TeammateError(404, "That teammate no longer exists.");
      // Only the rows that change, so the other teammates keep their revisions.
      const leads = sql`(${teammates.id} = ${id})`;
      await tx
        .update(teammates)
        .set({ isLead: leads })
        .where(sql`${teammates.isLead} <> ${leads}`);
    });
    await publishApp(this.ctx, { type: "teammates" });
  }

  /**
   * Archives a teammate: its chats are archived, its automations paused and its work stopped, all
   * at once. Its screen stops and its browser history goes; sign-ins stay shared with the others.
   */
  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.ctx.db.transaction(async (tx) => {
      // Its main chat lock too, so a main chat being made for it now is archived with the rest.
      await lockUntilCommit(tx, LOCKS.team, LOCKS.mainChat(id));
      // Its runs before its row, the order a memory write takes them in, so the two can't deadlock.
      await requestTeammateRunsCancel(tx, id, now);
      await tx
        .update(teammates)
        .set({ archivedAt: now, isLead: false })
        .where(eq(teammates.id, id));
      await archiveChatsOf(tx, id, now);
      await pauseSchedulesOf(tx, id);
      await pauseTriggersOf(tx, id);
    });
    await notify(this.ctx.pool, NOTIFY_CHANNELS.worker, "cancel").catch((error: unknown) =>
      this.ctx.log.warn("teammate archived, but its runs weren't told to stop", {
        teammateId: id,
        error: errorMessage(error),
      }),
    );
    const forget = () => this.ctx.computer.forgetScreen(id);
    await (
      this.ctx.lifecycle ? this.ctx.lifecycle.run("archive teammate", forget) : forget()
    ).catch((error: unknown) =>
      this.ctx.log.warn("teammate archived; its screen is cleaned up later", {
        teammateId: id,
        error: errorMessage(error),
      }),
    );
    for (const type of ["teammates", "chats", "schedules", "triggers"] as const)
      await publishApp(this.ctx, { type });
  }

  /** A teammate's monthly budget in dollars, or null so it can't pay at all, and its auto-approve. */
  async setBudget(id: string, budget: number | null, autoApprove: number): Promise<void> {
    const budgetCents = budget === null ? null : toCents(budget);
    if (budget !== null && budgetCents === null)
      throw new TeammateError(400, "Give the budget in dollars, like 100.");
    const autoApproveCents = toCents(autoApprove) ?? 0;
    if (budgetCents !== null && autoApproveCents > budgetCents)
      throw new TeammateError(
        400,
        "The amount to approve on its own can't be more than the budget.",
      );
    const [updated] = await this.ctx.db
      .update(teammates)
      .set({ monthlyBudgetCents: budgetCents, autoApproveCents })
      .where(and(eq(teammates.id, id), isNull(teammates.archivedAt)))
      .returning({ id: teammates.id });
    if (!updated) throw new TeammateError(404, "That teammate no longer exists.");
    await publishApp(this.ctx, { type: "purchases" });
  }

  /**
   * A teammate suggests new instructions for itself; the owner decides. A newer suggestion
   * replaces one still waiting.
   */
  async proposeInstructions(input: InstructionProposalInput): Promise<void> {
    await addProposal(this.ctx, input);
  }

  /**
   * Takes a teammate's suggested instructions; they apply from its next message. A suggestion
   * still waiting is taken only as you reviewed it: with the teammate's instructions still
   * `expectedInstructions` (when given) and the teammate not archived, checked with its row
   * locked, so an edit or archive meanwhile waits or refuses this. Taking one already taken
   * succeeds again and changes nothing.
   */
  async acceptProposal(proposalId: string, expectedInstructions?: string): Promise<void> {
    const updated = await this.ctx.db.transaction(async (tx) => {
      await checkReviewed(tx, proposalId, expectedInstructions);
      const proposal = await decideProposal(tx, proposalId, "accepted");
      if (!proposal) return null;
      const [teammate] = await tx
        .update(teammates)
        .set({ instructions: proposal.proposed })
        .where(eq(teammates.id, proposal.teammateId))
        .returning();
      return teammate ?? null;
    });
    if (updated) await this.sync(updated);
    await publishApp(this.ctx, { type: "teammates" });
  }

  async dismissProposal(proposalId: string): Promise<void> {
    await this.ctx.db.transaction((tx) => decideProposal(tx, proposalId, "dismissed"));
    await publishApp(this.ctx, { type: "teammates" });
  }

  /** Writes the workspace now; if the computer is away, it is written before the next run. */
  private async sync(teammate: Teammate): Promise<boolean> {
    if (this.ctx.lifecycle?.resting) return false;
    try {
      await this.syncWorkspace(teammate);
      return true;
    } catch (error) {
      this.ctx.log.warn("teammate saved; workspace will sync before its next run", {
        teammateId: teammate.id,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    return connectionSummaries(this.ctx.db);
  }

  async setConnection(
    teammateId: string,
    connectionId: string,
    assigned: boolean,
    expectedRevision: string,
  ) {
    await this.requireTeammate(teammateId);
    return assignConnection(this.ctx, teammateId, connectionId, assigned, expectedRevision);
  }
}
