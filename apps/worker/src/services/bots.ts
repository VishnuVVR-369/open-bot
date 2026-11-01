import {
  bots,
  chats,
  connections,
  schedules,
  settings,
  triggers,
  configurationRevision,
} from "@open-bot/db";
import {
  BOT_COLORS,
  botCreation,
  botProfileChangesSchema,
  slugify,
  TEAMMATE_TEMPLATES,
  type BotCreationPlan,
  type BotProfile,
  type CreateBotInput,
  type CreatedBot,
} from "@open-bot/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { errorMessage } from "../logger";
import type { Bot } from "../runs/session";
import type { ScheduleService } from "./schedules";
import type { SkillService } from "./skills";

export class BotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serialises slug allocation and the first-teammate choice across concurrent creates. */
const CREATE_LOCK = 78123401;

/** A connection as teammates see it: no credentials, with a revision for safe edits. */
export interface ConnectionSummary {
  id: string;
  label: string;
  enabled: boolean;
  /** Teammates that may use it, or null for every teammate. */
  botIds: string[] | null;
  revision: string;
}

export type CreatedBy = { kind: "user" } | { kind: "bot"; botId: string; runId: string };

/**
 * Creating and editing teammates, for the web app and for teammates' own tools alike. Edits use
 * an optimistic revision, so nobody silently overwrites a change made since they read it.
 */
export class BotService {
  constructor(
    private readonly ctx: Context,
    private readonly schedules: ScheduleService,
    private readonly skills: SkillService,
    private readonly syncWorkspace: (bot: Bot) => Promise<void>,
  ) {}

  /** A teammate's revision, from everything saved on it. */
  static revision(bot: Bot): string {
    return configurationRevision(bot);
  }

  templates() {
    return TEAMMATE_TEMPLATES;
  }

  /** The teammate, unless it was deleted or archived. */
  async requireBot(id: string): Promise<Bot> {
    const [bot] = await this.ctx.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, id), isNull(bots.archivedAt)));
    if (!bot) throw new BotError(404, "That teammate no longer exists or is archived.");
    return bot;
  }

  async list() {
    const rows = await this.ctx.db
      .select({
        id: bots.id,
        name: bots.name,
        role: bots.role,
        emoji: bots.emoji,
        autonomy: bots.autonomy,
        chatId: chats.id,
      })
      .from(bots)
      .leftJoin(
        chats,
        and(eq(chats.botId, bots.id), eq(chats.kind, "direct"), isNull(chats.archivedAt)),
      )
      .where(isNull(bots.archivedAt))
      .orderBy(asc(bots.createdAt));
    return rows.map(({ chatId, ...row }) => ({
      ...row,
      chatPath: chatId ? `/chats/${chatId}` : null,
    }));
  }

  /** A teammate's whole setup: profile, skills, automations and the connections it can use. */
  async get(id: string) {
    const bot = await this.requireBot(id);
    const [skills, routines, watches, services, direct] = await Promise.all([
      this.skills.forBot(id),
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
        .where(eq(schedules.botId, id)),
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
        .where(eq(triggers.botId, id)),
      this.listConnections(),
      this.ctx.db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.botId, id), eq(chats.kind, "direct"), isNull(chats.archivedAt))),
    ]);
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      emoji: bot.emoji,
      autonomy: bot.autonomy,
      revision: BotService.revision(bot),
      chatPath: direct[0] ? `/chats/${direct[0].id}` : null,
      skills: skills.map(({ id, name, description, instructions, botId }) => ({
        id,
        name,
        description,
        instructions,
        sharedWithEveryone: botId === null,
      })),
      schedules: routines,
      triggers: watches,
      connections: services.filter(
        (service) => service.enabled && (service.botIds === null || service.botIds.includes(id)),
      ),
    };
  }

  /** The least used color, so teammates created in a row don't all look the same. */
  private async nextColor(): Promise<string> {
    const used = await this.ctx.db
      .select({ color: bots.color })
      .from(bots)
      .where(isNull(bots.archivedAt));
    const count = (color: string) => used.filter((row) => row.color === color).length;
    return [...BOT_COLORS].sort((a, b) => count(a) - count(b))[0]!;
  }

  /** Resolves a request into what will be created, so it can be shown before anything is. */
  async plan(input: CreateBotInput): Promise<BotCreationPlan> {
    return botCreation(input, await this.nextColor());
  }

  /** Checks a plan's schedules, so an approval is never asked for one that can't be saved. */
  async checkPlan(plan: BotCreationPlan): Promise<void> {
    for (const schedule of plan.schedules) {
      try {
        await this.schedules.check({ ...schedule, timezone: null });
      } catch (error) {
        throw new BotError(400, `Schedule "${schedule.title}": ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Creates the teammate and its direct chat, then its skills and schedules. The teammate exists
   * even when one of those fails; the failures are reported so they can be added afterwards.
   */
  async create(
    input: CreateBotInput | BotCreationPlan,
    by: CreatedBy = { kind: "user" },
  ): Promise<CreatedBot> {
    const plan = "profile" in input ? input : await this.plan(input);
    const { profile } = plan;
    const created = await this.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_LOCK})`);
      const rows = await tx.select({ slug: bots.slug, archivedAt: bots.archivedAt }).from(bots);
      const taken = new Set(rows.map((row) => row.slug));
      const base = slugify(profile.name);
      let slug = base;
      for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
      const [bot] = await tx
        .insert(bots)
        .values({ ...profile, slug, isPrimary: !rows.some((row) => !row.archivedAt) })
        .returning();
      const [chat] = await tx
        .insert(chats)
        .values({ kind: "direct", title: profile.name, botId: bot!.id })
        .returning({ id: chats.id });
      return { bot: bot!, chatId: chat!.id };
    });
    const botId = created.bot.id;
    const failed: CreatedBot["failed"] = [];
    const [preferences] = await this.ctx.db
      .select({ timezone: settings.timezone })
      .from(settings)
      .where(eq(settings.id, 1));
    for (const schedule of plan.schedules) {
      await this.schedules
        .create({
          botId,
          ...schedule,
          timezone: preferences?.timezone ?? "UTC",
          createdBy: by.kind,
          createdByRunId: by.kind === "bot" ? by.runId : null,
        })
        .catch((error: unknown) =>
          failed.push({ kind: "schedule", name: schedule.title, error: errorMessage(error) }),
        );
    }
    for (const skill of plan.skills) {
      await this.skills
        .save({ ...skill, botId }, by.kind === "bot" ? { kind: "bot", botId: by.botId } : by)
        .catch((error: unknown) =>
          failed.push({ kind: "skill", name: skill.name, error: errorMessage(error) }),
        );
    }
    const workspaceSynced = await this.sync(created.bot);
    await publishApp(this.ctx, { type: "bots" });
    await publishApp(this.ctx, { type: "chats" });
    return {
      botId,
      name: created.bot.name,
      chatId: created.chatId,
      chatPath: `/chats/${created.chatId}`,
      revision: BotService.revision(created.bot),
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
  async update(id: string, changes: Partial<BotProfile>, expectedRevision?: string) {
    const parsed = botProfileChangesSchema.safeParse(changes);
    if (!parsed.success) throw new BotError(400, parsed.error.issues[0]!.message);
    const patch = parsed.data;
    const updated = await this.ctx.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(bots)
        .where(and(eq(bots.id, id), isNull(bots.archivedAt)))
        .for("update");
      if (!current) throw new BotError(404, "That teammate no longer exists or is archived.");
      if (expectedRevision && BotService.revision(current) !== expectedRevision)
        throw new BotError(
          409,
          "This teammate was changed since it was loaded. Reload it and try again.",
        );
      const [bot] = await tx.update(bots).set(patch).where(eq(bots.id, id)).returning();
      if (patch.name !== undefined)
        await tx
          .update(chats)
          .set({ title: patch.name })
          .where(and(eq(chats.botId, id), eq(chats.kind, "direct")));
      return bot!;
    });
    const workspaceSynced = await this.sync(updated);
    await publishApp(this.ctx, { type: "bots" });
    if (patch.name !== undefined) await publishApp(this.ctx, { type: "chats" });
    return { botId: id, revision: BotService.revision(updated), workspaceSynced };
  }

  /** Writes the workspace now; if the computer is away, it is written before the next run. */
  private async sync(bot: Bot): Promise<boolean> {
    try {
      await this.syncWorkspace(bot);
      return true;
    } catch (error) {
      this.ctx.log.warn("teammate saved; workspace will sync before its next run", {
        botId: bot.id,
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
        botIds: connections.botIds,
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
    botId: string,
    assigned: boolean,
    expectedRevision: string,
  ): { botIds: string[] } | "unchanged" {
    if (connection.revision !== expectedRevision)
      throw new BotError(
        409,
        "That connection changed. List connections again before assigning it.",
      );
    if (assigned && !connection.enabled)
      throw new BotError(
        400,
        "This connection is turned off. The user can turn it on in Settings.",
      );
    if (connection.botIds === null) {
      if (assigned) return "unchanged";
      throw new BotError(
        400,
        "This connection is shared with every teammate. The user can limit it to some teammates in Settings.",
      );
    }
    const has = connection.botIds.includes(botId);
    if (has === assigned) return "unchanged";
    return {
      botIds: assigned
        ? [...connection.botIds, botId]
        : connection.botIds.filter((id) => id !== botId),
    };
  }

  async setConnection(
    botId: string,
    connectionId: string,
    assigned: boolean,
    expectedRevision: string,
  ) {
    await this.requireBot(botId);
    const changed = await this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: connections.id,
          label: connections.label,
          enabled: connections.enabled,
          botIds: connections.botIds,
          updatedAt: connections.updatedAt,
        })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update");
      if (!row) throw new BotError(404, "That connection no longer exists.");
      const change = BotService.assignment(
        connectionSummary(row),
        botId,
        assigned,
        expectedRevision,
      );
      if (change === "unchanged") return false;
      await tx.update(connections).set(change).where(eq(connections.id, connectionId));
      return true;
    });
    if (changed) await publishApp(this.ctx, { type: "connections" });
    return { botId, connectionId, assigned, effectiveFrom: "the teammate's next run" };
  }
}

function connectionSummary(row: {
  id: string;
  label: string;
  enabled: boolean;
  botIds: string[] | null;
  updatedAt: Date;
}): ConnectionSummary {
  const { updatedAt, ...summary } = row;
  return { ...summary, revision: configurationRevision({ ...summary, updatedAt }) };
}
