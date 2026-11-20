import {
  approvalRules,
  teammates,
  chatMembers,
  configurationRevision,
  connections,
  instructionProposals,
  lessons,
  LOCKS,
  lockUntilCommit,
  notify,
  ownerTimeZone,
  type Queryable,
  schedules,
  skills,
  triggers,
  type Tx,
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
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
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
import { setConnectionTeammates } from "../connections";
import { WorkerError } from "../../core/errors";

/** What a teammate is made of besides its profile: what copying and exporting carry over. */
export type TeammateParts = Omit<TeammateBundle, "format" | "version" | "teammate">;

/** The memory a new teammate can start with. */
export type TeammateMemory = Pick<MemoryService, "copyTeammate" | "addLessons">;

export class TeammateError extends WorkerError {}

/** A connection as teammates see it: no credentials, with a revision for safe edits. */
export interface ConnectionSummary {
  id: string;
  label: string;
  enabled: boolean;
  /** Teammates that may use it, or null for every teammate. */
  teammateIds: string[] | null;
  revision: string;
}

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

export type CreatedBy = { kind: "user" } | { kind: "bot"; teammateId: string; runId: string };

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

  /** A teammate's revision, from everything saved on it. */
  static revision(teammate: Teammate): string {
    return configurationRevision(teammate);
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
          createdByRunId: by.kind === "bot" ? by.runId : null,
        })
        .catch((error: unknown) =>
          failed.push({ kind: "schedule", name: schedule.title, error: errorMessage(error) }),
        );
    }
    for (const skill of plan.skills) {
      await this.skills
        .save(
          { ...skill, teammateId },
          by.kind === "bot" ? { kind: "bot", teammateId: by.teammateId } : by,
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
      if (expectedRevision && TeammateService.revision(current) !== expectedRevision)
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
        ...(await this.parts(id)),
      },
    };
  }

  /** A teammate's own skills, routines, page watches, approval rules and lessons. */
  private async parts(id: string): Promise<TeammateParts> {
    const db = this.ctx.db;
    const [ownSkills, routines, watches, allowed, learned] = await Promise.all([
      db.select().from(skills).where(eq(skills.teammateId, id)).orderBy(asc(skills.name)),
      db
        .select()
        .from(schedules)
        .where(
          and(eq(schedules.teammateId, id), eq(schedules.kind, "cron"), isNotNull(schedules.cron)),
        )
        .orderBy(asc(schedules.createdAt)),
      db
        .select()
        .from(triggers)
        .where(and(eq(triggers.teammateId, id), eq(triggers.kind, "watch")))
        .orderBy(asc(triggers.createdAt)),
      db
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.teammateId, id))
        .orderBy(asc(approvalRules.createdAt)),
      db.select().from(lessons).where(eq(lessons.teammateId, id)).orderBy(asc(lessons.createdAt)),
    ]);
    return {
      skills: ownSkills.map(({ name, description, instructions }) => ({
        name,
        description,
        instructions,
      })),
      routines: routines.map((routine) => ({
        title: routine.title,
        prompt: routine.prompt,
        cron: routine.cron!,
        quiet: routine.quiet,
      })),
      watches: watches.map((watch) => ({
        title: watch.title,
        prompt: watch.prompt,
        url: watch.url!,
        intervalMinutes: watch.intervalMinutes!,
        lookFor: watch.lookFor,
      })),
      allowed: allowed.map((rule) => ({ kind: rule.kind, pattern: rule.pattern })),
      lessons: learned.map((lesson) => lesson.text),
    };
  }

  /**
   * Adds a teammate with this profile and these parts, with its direct chat, in one transaction:
   * routines and watches start paused, so nothing runs twice or by surprise. `copiedFrom` is still
   * on the team when the copy is made, or the copy is refused.
   */
  private async addTeammate(
    profile: Pick<Teammate, "name" | "role" | "instructions" | "color" | "emoji" | "autonomy">,
    parts: TeammateParts,
    copiedFrom?: string,
  ): Promise<{ teammate: Teammate; chatId: string }> {
    const timezone = await ownerTimeZone(this.ctx.db);
    // Its lessons live in memory: saved in the same transaction as the rest.
    return this.ctx.db.transaction(async (tx) => {
      await lockUntilCommit(tx, LOCKS.team);
      const team = await tx
        .select({ id: teammates.id, slug: teammates.slug, archivedAt: teammates.archivedAt })
        .from(teammates);
      // Archiving takes the team lock too, so the original is still on the team if it's here now.
      if (copiedFrom && !team.some((row) => row.id === copiedFrom && !row.archivedAt))
        throw new TeammateError(404, "That teammate no longer exists.");
      const { slug, first } = newTeammateSlot(team, profile.name);
      const [teammate] = await tx
        .insert(teammates)
        .values({ ...profile, slug, isLead: first })
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
      if (copiedFrom) await copyUpcomingReminders(tx, copiedFrom, id);
      await this.memory.addLessons(id, parts.lessons, tx);
      return { teammate: teammate!, chatId };
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
   */
  async duplicate(id: string, name: string, copyMemory: boolean) {
    const source = await this.requireTeammate(id);
    const { lessons: learned, ...parts } = await this.parts(id);
    const { role, instructions, color, emoji, autonomy } = source;
    const created = await this.addTeammate(
      { name, role, instructions, color, emoji, autonomy },
      { ...parts, lessons: copyMemory ? learned : [] },
      id,
    );
    let memoryCopied = !copyMemory;
    if (copyMemory)
      memoryCopied = await this.memory.copyTeammate(id, created.teammate.id).then(
        () => true,
        (error: unknown) => {
          this.ctx.log.warn("teammate copied, but its memory wasn't", {
            teammateId: created.teammate.id,
            error: errorMessage(error),
          });
          return false;
        },
      );
    await this.welcome(created.teammate);
    return { teammateId: created.teammate.id, chatId: created.chatId, memoryCopied };
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
  async proposeInstructions(input: {
    teammateId: string;
    current: string;
    proposed: string;
    reason: string;
    runId: string;
  }): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
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
    await publishApp(this.ctx, { type: "teammates" });
  }

  /** Takes a teammate's suggested instructions; they apply from its next message. */
  async acceptProposal(proposalId: string): Promise<void> {
    const updated = await this.ctx.db.transaction(async (tx) => {
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
    const rows = await this.ctx.db
      .select({
        id: connections.id,
        label: connections.label,
        enabled: connections.enabled,
        teammateIds: connections.teammateIds,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .orderBy(asc(connections.label));
    return rows.map((row) => connectionSummary(row));
  }

  /**
   * Why giving or taking a teammate's access to a connection can't happen, or what it would
   * change. Checked before asking for approval and again inside the change.
   */
  static assignment(
    connection: ConnectionSummary,
    teammateId: string,
    assigned: boolean,
    expectedRevision: string,
  ): { teammateIds: string[] } | "unchanged" {
    if (connection.revision !== expectedRevision)
      throw new TeammateError(
        409,
        "That connection changed. List connections again before assigning it.",
      );
    if (assigned && !connection.enabled)
      throw new TeammateError(
        400,
        "This connection is turned off. The user can turn it on in Settings.",
      );
    if (connection.teammateIds === null) {
      if (assigned) return "unchanged";
      throw new TeammateError(
        400,
        "This connection is shared with every teammate. The user can limit it to some teammates in Settings.",
      );
    }
    const has = connection.teammateIds.includes(teammateId);
    if (has === assigned) return "unchanged";
    return {
      teammateIds: assigned
        ? [...connection.teammateIds, teammateId]
        : connection.teammateIds.filter((id) => id !== teammateId),
    };
  }

  async setConnection(
    teammateId: string,
    connectionId: string,
    assigned: boolean,
    expectedRevision: string,
  ) {
    await this.requireTeammate(teammateId);
    const changed = await this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: connections.id,
          label: connections.label,
          enabled: connections.enabled,
          teammateIds: connections.teammateIds,
          updatedAt: connections.updatedAt,
        })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update");
      if (!row) throw new TeammateError(404, "That connection no longer exists.");
      const change = TeammateService.assignment(
        connectionSummary(row),
        teammateId,
        assigned,
        expectedRevision,
      );
      if (change === "unchanged") return false;
      await setConnectionTeammates(tx, connectionId, change.teammateIds);
      return true;
    });
    if (changed) await publishApp(this.ctx, { type: "connections" });
    return { teammateId, connectionId, assigned, effectiveFrom: "the teammate's next run" };
  }
}

function connectionSummary(row: {
  id: string;
  label: string;
  enabled: boolean;
  teammateIds: string[] | null;
  updatedAt: Date;
}): ConnectionSummary {
  const { updatedAt, ...summary } = row;
  return { ...summary, revision: configurationRevision({ ...summary, updatedAt }) };
}

/** The teammate a suggestion is for, under the column's legacy name. */
const suggestedFor = instructionProposals.teammateId;

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
