import { teammates, ownerTimeZone, runs, schedules, type Queryable, type Tx } from "@open-bot/db";
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
import { announceRun, enqueueRun, insertRun, type RunInput } from "../../runs/queue";
import { errorMessage } from "../../logger";
import { mainChat } from "../chat";
import { WorkerError } from "../../core/errors";

export type Schedule = typeof schedules.$inferSelect;

/** A schedule that can't be saved or run as asked; the message says why. */
export class ScheduleError extends WorkerError {
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(status, message);
  }
}

/** What `patch` may change: only the fields given, each checked as `update` checks it. */
export interface SchedulePatch {
  title?: string;
  /** Exactly one of `cron` (recurring) or `at` (one time, wall-clock in the schedule's zone). */
  timing?: { cron: string | null; at: string | null };
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
    teammateId: string;
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
        teammateId: input.teammateId,
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
      teammateId: string;
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
        teammateId: input.teammateId,
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

  /**
   * Change only the fields given, as the phone edits a name or a time: the prompt, the teammate
   * and anything else changed elsewhere meanwhile stay as they are. The row is locked while it's
   * read and written, so an edit that lands at the same moment isn't lost. New timing is read in
   * the schedule's own time zone, follows `update`'s rules (a reminder that already ran runs again
   * at its new time), and a one-time reminder is never quiet, as the web's form saves it.
   */
  async patch(id: string, changes: SchedulePatch): Promise<Schedule> {
    const title = changes.title?.trim();
    if (changes.title !== undefined && !title) throw new ScheduleError("Give it a name.");
    if (title && title.length > 80) throw new ScheduleError("Keep the name under 80 characters.");
    const row = await this.ctx.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schedules)
        .where(eq(schedules.id, id))
        .for("update");
      if (!existing) throw new ScheduleError("That schedule was deleted.", 404);
      const timing = changes.timing
        ? await this.timing({ ...changes.timing, timezone: existing.timezone })
        : null;
      const finishedReminder = existing.kind === "once" && !existing.enabled && existing.lastRunAt;
      const rerun = timing?.kind === "once" && Boolean(finishedReminder);
      const [updated] = await tx
        .update(schedules)
        .set({
          ...(title ? { title } : {}),
          ...(timing ?? {}),
          ...(timing?.kind === "once" ? { quiet: false } : {}),
          ...(rerun ? { enabled: true, lastRunAt: null } : {}),
        })
        .where(eq(schedules.id, id))
        .returning();
      return updated!;
    });
    await publishApp(this.ctx, { type: "schedules" });
    this.kick();
    return row;
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

  async cancelForTeammate(teammateId: string, id: string): Promise<Schedule | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.ctx.db
      .delete(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.teammateId, teammateId)))
      .returning();
    if (row) await publishApp(this.ctx, { type: "schedules" });
    return row ?? null;
  }

  async describeForTeammate(teammateId: string): Promise<string> {
    const rows = await this.ctx.db
      .select()
      .from(schedules)
      .where(eq(schedules.teammateId, teammateId))
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

  /**
   * Run a schedule now, without changing when it runs next. `runId`, when given, is the run's id:
   * asking again with it after an answer that was lost finds that run and starts nothing more.
   */
  async runNow(id: string, runId?: string): Promise<void> {
    const [row] = await this.ctx.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) throw new ScheduleError("Schedule not found");
    if (runId && (await this.ranAs(id, runId))) return;
    try {
      await this.fire(row, runId);
    } catch (error) {
      // The same ask, sent twice at once: the first one saved the run.
      if (runId && (await this.ranAs(id, runId))) return;
      throw error;
    }
  }

  /** Whether the run `runId` is this schedule's; an id another run has is refused. */
  private async ranAs(scheduleId: string, runId: string): Promise<boolean> {
    const [run] = await this.ctx.db
      .select({ scheduleId: runs.scheduleId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) return false;
    if (run.scheduleId !== scheduleId)
      throw new ScheduleError("That run id was already used for something else.", 409);
    return true;
  }

  private async fire(row: Schedule, runId?: string) {
    const chatId = await this.runChat(row);
    if (!chatId) return;
    await enqueueRun(this.ctx, { ...runInput(row, chatId), ...(runId ? { id: runId } : {}) });
  }

  /** The chat a schedule's run goes to: its teammate's main chat, unless it's archived. */
  private async runChat(row: Schedule): Promise<string | null> {
    const [teammate] = await this.ctx.db
      .select()
      .from(teammates)
      .where(eq(teammates.id, row.teammateId));
    if (!teammate || teammate.archivedAt) return null;
    return mainChat(this.ctx, row.teammateId);
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
    const due = await this.ctx.db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, new Date())));
    let started = false;
    for (const { id } of due) {
      try {
        if (await this.fireDue(id)) started = true;
      } catch (error) {
        // Still due, so the next tick tries it again; the others go on.
        this.ctx.log.error("a schedule couldn't start its run", {
          scheduleId: id,
          error: errorMessage(error),
        });
      }
    }
    if (started) await publishApp(this.ctx, { type: "schedules" });
  }

  /**
   * Claim a due schedule by moving its next run forward, and queue its run in the same
   * transaction, so a run that can't be saved leaves the schedule due and a slow tick never runs it
   * twice. True when the schedule was claimed.
   */
  private async fireDue(id: string): Promise<boolean> {
    let claimed = false;
    const chatId = await this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.id, id),
            eq(schedules.enabled, true),
            lte(schedules.nextRunAt, new Date()),
          ),
        )
        .for("update", { skipLocked: true });
      if (!row) return null;
      claimed = true;
      const now = new Date();
      const nextRunAt =
        row.kind === "cron" && row.cron ? nextCronRun(row.cron, row.timezone, now) : null;
      await tx
        .update(schedules)
        .set({ lastRunAt: now, nextRunAt, enabled: row.kind === "cron" })
        .where(eq(schedules.id, row.id));
      const chat = await this.runChat(row);
      if (chat) await insertRun(tx, runInput(row, chat));
      return chat;
    });
    if (chatId) await announceRun(this.ctx, chatId);
    return claimed;
  }
}

/** The run a schedule starts. */
function runInput(row: Schedule, chatId: string): RunInput {
  return {
    chatId,
    lane: `schedule:${row.id}`,
    teammateId: row.teammateId,
    trigger: "schedule",
    scheduleId: row.id,
    prompt: `[Scheduled task: "${row.title}"]\n\n${row.prompt}${row.quiet ? `\n\n${QUIET_NOTE}` : ""}`,
  };
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
          teammateId,
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
    .where(and(eq(schedules.teammateId, fromTeammateId), eq(schedules.kind, "once")));
  const upcoming = reminders.filter((reminder) => (reminder.runAt?.getTime() ?? 0) > Date.now());
  if (upcoming.length === 0) return;
  await tx.insert(schedules).values(
    upcoming.map((reminder) => ({
      teammateId: toTeammateId,
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
  await tx.update(schedules).set({ enabled: false }).where(eq(schedules.teammateId, teammateId));
}
