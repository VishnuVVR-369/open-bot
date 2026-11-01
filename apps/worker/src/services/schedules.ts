import { bots, chats, schedules, settings } from "@open-bot/db";
import {
  describeCron,
  isValidTimeZone,
  nextCronRun,
  parseLocalDateTime,
  QUIET_NOTE,
  validateCron,
} from "@open-bot/shared";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { enqueueRun, publishApp, type Context } from "../context";
import { errorMessage } from "../logger";

export type Schedule = typeof schedules.$inferSelect;

const TICK_MS = 10_000;

/** The bot's "Scheduled" chat, where its routines and reminders run. */
export async function scheduledChatFor(ctx: Context, botId: string): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.botId, botId), eq(chats.kind, "scheduled"), isNull(chats.archivedAt)));
  if (existing) return existing.id;
  const [created] = await ctx.db
    .insert(chats)
    .values({ kind: "scheduled", title: "Scheduled", botId })
    .returning({ id: chats.id });
  await publishApp(ctx, { type: "chats" });
  return created!.id;
}

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;

  constructor(private readonly ctx: Context) {}

  private async defaultTimeZone(): Promise<string> {
    const [row] = await this.ctx.db
      .select({ timezone: settings.timezone })
      .from(settings)
      .where(eq(settings.id, 1));
    return row?.timezone ?? "UTC";
  }

  /** When a schedule runs, from a cron expression or a local date and time. */
  private async timing(input: { cron: string | null; at: string | null; timezone: string | null }) {
    const timezone = input.timezone ?? (await this.defaultTimeZone());
    if (!isValidTimeZone(timezone)) throw new Error(`Unknown timezone ${timezone}`);
    if (Boolean(input.cron) === Boolean(input.at))
      throw new Error("Give exactly one of cron (recurring) or at (one time).");
    if (input.cron) {
      const problem = validateCron(input.cron, timezone);
      if (problem) throw new Error(problem);
      const nextRunAt = nextCronRun(input.cron, timezone);
      return { kind: "cron" as const, cron: input.cron, runAt: null, nextRunAt, timezone };
    }
    const nextRunAt = parseLocalDateTime(input.at!, timezone);
    if (nextRunAt.getTime() < Date.now() - 60_000) throw new Error("That time is in the past.");
    return { kind: "once" as const, cron: null, runAt: nextRunAt, nextRunAt, timezone };
  }

  /** Throws what `create` would reject about the timing, without saving anything. */
  async check(input: { cron: string | null; at: string | null; timezone: string | null }) {
    await this.timing(input);
  }

  async create(input: {
    botId: string;
    title: string;
    prompt: string;
    cron: string | null;
    at: string | null;
    timezone: string | null;
    /** Only tell the user when there's news. */
    quiet?: boolean;
    createdBy: "user" | "bot";
    createdByRunId?: string | null;
  }): Promise<Schedule> {
    const timing = await this.timing(input);
    const [row] = await this.ctx.db
      .insert(schedules)
      .values({
        botId: input.botId,
        title: input.title,
        prompt: input.prompt,
        quiet: input.quiet ?? false,
        ...timing,
        createdBy: input.createdBy,
        createdByRunId: input.createdByRunId ?? null,
      })
      .returning();
    await publishApp(this.ctx, { type: "schedules" });
    this.kick();
    return row!;
  }

  /**
   * Change what a schedule does and when. A paused routine stays paused; a reminder that already
   * ran is set up to run again at its new time.
   */
  async update(
    id: string,
    input: {
      botId: string;
      title: string;
      prompt: string;
      cron: string | null;
      at: string | null;
      timezone: string | null;
      /** Left out, it stays as it was. */
      quiet?: boolean;
    },
  ): Promise<Schedule> {
    const [existing] = await this.ctx.db.select().from(schedules).where(eq(schedules.id, id));
    if (!existing) throw new Error("That schedule no longer exists.");
    const timing = await this.timing(input);
    const finishedReminder = existing.kind === "once" && !existing.enabled && existing.lastRunAt;
    const enabled = timing.kind === "once" && finishedReminder ? true : existing.enabled;
    const [row] = await this.ctx.db
      .update(schedules)
      .set({
        botId: input.botId,
        title: input.title,
        prompt: input.prompt,
        ...(input.quiet === undefined ? {} : { quiet: input.quiet }),
        ...timing,
        enabled,
        ...(enabled && finishedReminder ? { lastRunAt: null } : {}),
      })
      .where(eq(schedules.id, id))
      .returning();
    await publishApp(this.ctx, { type: "schedules" });
    this.kick();
    return row!;
  }

  /** Pause or resume. A reminder whose time has passed can't be resumed; it would never run. */
  async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
    const [row] = await this.ctx.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) throw new Error("That schedule no longer exists.");
    let nextRunAt = row.nextRunAt;
    if (enabled && row.kind === "cron" && row.cron) nextRunAt = nextCronRun(row.cron, row.timezone);
    if (enabled && row.kind === "once" && row.runAt && row.runAt.getTime() < Date.now())
      throw new Error("That reminder's time has passed. Give it a new time to run it again.");
    const [updated] = await this.ctx.db
      .update(schedules)
      .set({ enabled, nextRunAt: enabled ? (nextRunAt ?? row.runAt) : nextRunAt })
      .where(eq(schedules.id, id))
      .returning();
    await publishApp(this.ctx, { type: "schedules" });
    this.kick();
    return updated!;
  }

  async cancelForBot(botId: string, id: string): Promise<Schedule | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.ctx.db
      .delete(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.botId, botId)))
      .returning();
    if (row) await publishApp(this.ctx, { type: "schedules" });
    return row ?? null;
  }

  async describeForBot(botId: string): Promise<string> {
    const rows = await this.ctx.db
      .select()
      .from(schedules)
      .where(eq(schedules.botId, botId))
      .orderBy(asc(schedules.nextRunAt));
    if (rows.length === 0) return "You have no schedules.";
    return rows
      .map((row) => {
        const when = row.kind === "cron" ? `${describeCron(row.cron!)} (${row.cron})` : "one time";
        const next =
          row.enabled && row.nextRunAt ? `next ${row.nextRunAt.toISOString()}` : "paused";
        return `- ${row.id}: "${row.title}", ${when}, ${row.timezone}, ${next}${row.quiet ? ", quiet" : ""}`;
      })
      .join("\n");
  }

  /** Run a schedule now, without changing when it runs next. */
  async runNow(id: string): Promise<void> {
    const [row] = await this.ctx.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) throw new Error("Schedule not found");
    await this.fire(row);
  }

  private async fire(row: Schedule) {
    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, row.botId));
    if (!bot || bot.archivedAt) return;
    const chatId = await scheduledChatFor(this.ctx, row.botId);
    await enqueueRun(this.ctx, {
      chatId,
      botId: row.botId,
      trigger: "schedule",
      scheduleId: row.id,
      prompt: `[Scheduled task: "${row.title}"]\n\n${row.prompt}${row.quiet ? `\n\n${QUIET_NOTE}` : ""}`,
    });
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Check for due schedules now. A kick during a check runs another pass right after it. */
  kick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.tick()
      .catch((error: unknown) =>
        this.ctx.log.error("scheduler tick failed", { error: errorMessage(error) }),
      )
      .finally(() => {
        this.ticking = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async tick() {
    const due = await this.ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, new Date())))
        .for("update", { skipLocked: true });
      for (const row of rows) {
        const now = new Date();
        const nextRunAt =
          row.kind === "cron" && row.cron ? nextCronRun(row.cron, row.timezone, now) : null;
        await tx
          .update(schedules)
          .set({ lastRunAt: now, nextRunAt, enabled: row.kind === "cron" })
          .where(eq(schedules.id, row.id));
      }
      return rows;
    });
    for (const row of due) await this.fire(row);
    if (due.length) await publishApp(this.ctx, { type: "schedules" });
  }
}
