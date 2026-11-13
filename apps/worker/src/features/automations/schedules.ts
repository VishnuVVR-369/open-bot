import { bots, ownerTimeZone, schedules, type Queryable, type Tx } from "@open-bot/db";
import {
  type Creator,
  describeCron,
  isValidTimeZone,
  nextCronRun,
  parseLocalDateTime,
  QUIET_NOTE,
  validateCron,
} from "@open-bot/domain";
import { and, asc, eq, lte } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { enqueueRun } from "../../runs/queue";
import { errorMessage } from "../../logger";
import { teammateChat } from "../chat";
import { WorkerError } from "../../core/errors";

export type Schedule = typeof schedules.$inferSelect;

/** A schedule that can't be saved or run as asked; the message says why. */
export class ScheduleError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

const TICK_MS = 10_000;

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;

  constructor(private readonly ctx: Context) {}

  /** When a schedule runs, from a cron expression or a local date and time. */
  private async timing(input: { cron: string | null; at: string | null; timezone: string | null }) {
    const timezone = input.timezone ?? (await ownerTimeZone(this.ctx.db));
    if (!isValidTimeZone(timezone)) throw new ScheduleError(`Unknown timezone ${timezone}`);
    if (Boolean(input.cron) === Boolean(input.at))
      throw new ScheduleError("Give exactly one of cron (recurring) or at (one time).");
    if (input.cron) {
      const problem = validateCron(input.cron, timezone);
      if (problem) throw new ScheduleError(problem);
      const nextRunAt = nextCronRun(input.cron, timezone);
      return { kind: "cron" as const, cron: input.cron, runAt: null, nextRunAt, timezone };
    }
    let nextRunAt: Date;
    try {
      nextRunAt = parseLocalDateTime(input.at!, timezone);
    } catch (error) {
      throw new ScheduleError(errorMessage(error));
    }
    if (nextRunAt.getTime() < Date.now() - 60_000)
      throw new ScheduleError("That time is in the past.");
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
    createdBy: Creator;
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
    if (!existing) throw new ScheduleError("That schedule no longer exists.");
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
    if (!row) throw new ScheduleError("That schedule no longer exists.");
    let nextRunAt = row.nextRunAt;
    if (enabled && row.kind === "cron" && row.cron) nextRunAt = nextCronRun(row.cron, row.timezone);
    if (enabled && row.kind === "once" && row.runAt && row.runAt.getTime() < Date.now())
      throw new ScheduleError(
        "That reminder's time has passed. Give it a new time to run it again.",
      );
    const [updated] = await this.ctx.db
      .update(schedules)
      .set({ enabled, nextRunAt: enabled ? (nextRunAt ?? row.runAt) : nextRunAt })
      .where(eq(schedules.id, id))
      .returning();
    await publishApp(this.ctx, { type: "schedules" });
    this.kick();
    return updated!;
  }

  /** Delete a schedule the owner no longer wants. One already gone is fine. */
  async remove(id: string): Promise<void> {
    const [row] = await this.ctx.db
      .delete(schedules)
      .where(eq(schedules.id, id))
      .returning({ id: schedules.id });
    if (row) await publishApp(this.ctx, { type: "schedules" });
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
    if (!row) throw new ScheduleError("Schedule not found");
    await this.fire(row);
  }

  private async fire(row: Schedule) {
    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, row.botId));
    if (!bot || bot.archivedAt) return;
    const chatId = await teammateChat(this.ctx, row.botId, "scheduled");
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

/**
 * Gives a new teammate these routines, paused so nothing runs twice or by surprise; the owner turns
 * them on in Automations. A cron this open-bot can't read is left out rather than failing the rest.
 */
export async function addPausedRoutines(
  tx: Queryable,
  teammateId: string,
  routines: readonly { title: string; prompt: string; cron: string; quiet: boolean }[],
  timezone: string,
): Promise<void> {
  const values = routines.flatMap((routine) => {
    try {
      const nextRunAt = nextCronRun(routine.cron, timezone);
      return [
        {
          botId: teammateId, // vocabulary: allow
          ...routine,
          kind: "cron" as const,
          timezone,
          nextRunAt,
          enabled: false,
          createdBy: "user" as const,
        },
      ];
    } catch {
      return [];
    }
  });
  if (values.length > 0) await tx.insert(schedules).values(values);
}

/** Copies one teammate's reminders still to come to another, paused. */
export async function copyUpcomingReminders(
  tx: Queryable,
  fromTeammateId: string,
  toTeammateId: string,
): Promise<void> {
  const reminders = await tx
    .select()
    .from(schedules)
    .where(and(eq(schedules.botId, fromTeammateId), eq(schedules.kind, "once")));
  const upcoming = reminders.filter((reminder) => (reminder.runAt?.getTime() ?? 0) > Date.now());
  if (upcoming.length === 0) return;
  await tx.insert(schedules).values(
    upcoming.map((reminder) => ({
      botId: toTeammateId, // vocabulary: allow
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
}

/** Pauses every schedule a teammate has, in the caller's transaction (archiving it). */
export async function pauseSchedulesOf(tx: Tx, teammateId: string): Promise<void> {
  await tx.update(schedules).set({ enabled: false }).where(eq(schedules.botId, teammateId));
}
