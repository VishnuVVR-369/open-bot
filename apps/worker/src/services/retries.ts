import { bots, runs } from "@open-bot/db";
import { isRunActive } from "@open-bot/domain";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { enqueueRun } from "../runs/queue";

export class RetryError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Runs a finished run's request again, once, however many times it is asked. */
export class RetryService {
  /** Retries in progress, by the run being retried. */
  private readonly retrying = new Map<string, Promise<void>>();

  constructor(private readonly ctx: Context) {}

  /** The new run, or the one an earlier retry already started. */
  async retry(runId: string): Promise<{ runId: string }> {
    const { ctx } = this;
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw new RetryError(404, "Run not found");
    if (isRunActive(run.status)) throw new RetryError(409, "That run is still going.");
    const [teammate] = await ctx.db.select().from(bots).where(eq(bots.id, run.botId));
    if (!teammate || teammate.archivedAt) throw new RetryError(409, "That teammate is archived.");
    // One retry at a time per run, so a repeated tap or request finds the first one's run.
    const previous = this.retrying.get(run.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      // Asked again after it already ran again: that's the retry, don't start another.
      // Compared in Postgres, which keeps microseconds that a JavaScript date drops.
      const [later] = await ctx.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.chatId, run.chatId),
            eq(runs.botId, run.botId),
            gt(runs.createdAt, sql`(select created_at from runs where id = ${run.id})`),
          ),
        )
        .orderBy(asc(runs.createdAt))
        .limit(1);
      if (later) return { runId: later.id };
      // The same request again, in the same chat; the bot's thread still has what happened.
      const newRunId = await enqueueRun(ctx, {
        chatId: run.chatId,
        botId: run.botId,
        trigger: run.trigger,
        prompt: run.prompt,
        attachments: run.attachments,
        scheduleId: run.scheduleId,
      });
      await publishApp(ctx, { type: "chats" });
      return { runId: newRunId };
    });
    const settled = next.then(
      () => {},
      () => {},
    );
    this.retrying.set(run.id, settled);
    void settled.then(() => {
      if (this.retrying.get(run.id) === settled) this.retrying.delete(run.id);
    });
    return next;
  }
}
