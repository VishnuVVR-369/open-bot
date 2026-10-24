import { desktopTakeovers, runs, type TakeoverEndReason } from "@open-bot/db";
import { isRunActive, type TakeoverRequestItem } from "@open-bot/shared";
import { and, desc, eq } from "drizzle-orm";
import {
  appendRunEvent,
  createNotification,
  enqueueRun,
  publishApp,
  type Context,
} from "../context";
import { errorMessage } from "../logger";
import type { RunSession } from "../runs/session";
import type { SessionRegistry } from "./registry";

const REQUEST_WAIT_MS = 10 * 60_000;

export type TakeoverWaitResult =
  { status: "handed_back"; note: string | null } | { status: "dismissed" } | { status: "pending" };

const AUTO_NOTES: Record<Exclude<TakeoverEndReason, "handed_back">, string> = {
  user_idle: "Control came back automatically after 10 minutes without input from the user.",
  user_disconnected:
    "Control came back automatically because the user's desktop view disconnected.",
};

/**
 * You taking control of a bot's screen, handing it back, and bots asking you to take over.
 * Every bot has its own screen, so a takeover stops only that bot; the others keep working.
 * botd owns the leases; this service records takeovers and tells the bots what happened.
 */
export class TakeoverService {
  /** Runs waiting for you to hand back, by takeover id. */
  private readonly waiters = new Map<
    string,
    { runId: string; resolve: (result: TakeoverWaitResult) => void }
  >();
  /** Screens you are handing back right now, so the lease change isn't treated as a timeout. */
  private readonly handingBack = new Set<string>();

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionRegistry,
  ) {
    ctx.computer.on("lease", (screenId, holder, previous, reason) => {
      // Control can come back without you pressing "Hand back": after inactivity or a lost connection.
      if (previous?.kind === "user" && holder?.kind !== "user" && !this.handingBack.has(screenId)) {
        const endReason: TakeoverEndReason =
          reason === "user_idle" || reason === "user_disconnected" ? reason : "handed_back";
        void this.finishActive(screenId, null, endReason).catch((error: unknown) =>
          ctx.log.error("could not finish a takeover", { error: errorMessage(error) }),
        );
      }
      void publishApp(ctx, { type: "lease" });
    });
  }

  private requestItem(
    row: typeof desktopTakeovers.$inferSelect,
    resolution: TakeoverRequestItem["resolution"],
    note?: string | null,
  ): TakeoverRequestItem {
    return {
      id: row.itemId!,
      kind: "takeover_request",
      takeoverRequestId: row.id,
      reason: row.reason ?? "",
      resolution,
      ...(note ? { note } : {}),
      status: resolution === "pending" || resolution === "taken" ? "running" : "completed",
      startedAt: row.createdAt.toISOString(),
      ...(resolution === "handed_back" || resolution === "dismissed"
        ? { completedAt: new Date().toISOString() }
        : {}),
    };
  }

  private async writeRequestItem(
    row: typeof desktopTakeovers.$inferSelect,
    item: TakeoverRequestItem,
  ) {
    if (!row.requestedByRunId || !row.itemId) return;
    const session = this.sessions.get(row.requestedByRunId);
    if (session) {
      session.putItem(item);
      return;
    }
    const [run] = await this.ctx.db
      .select({ chatId: runs.chatId })
      .from(runs)
      .where(eq(runs.id, row.requestedByRunId));
    if (run)
      await appendRunEvent(this.ctx, row.requestedByRunId, run.chatId, { type: "item", item });
  }

  /** A bot asks you to take over its screen. Waits up to 10 minutes for you to hand back. */
  async requestFromBot(
    session: RunSession,
    input: { reason: string; itemId: string },
  ): Promise<TakeoverWaitResult> {
    const screenId = session.bot.id;
    const [row] = await this.ctx.db
      .insert(desktopTakeovers)
      .values({
        screenId,
        status: "requested",
        requestedByRunId: session.run.id,
        requestedByBotId: session.bot.id,
        reason: input.reason,
        itemId: input.itemId,
      })
      .returning();
    // If you already have control of this screen, the request joins your current takeover.
    if (this.ctx.computer.lease(screenId)?.kind === "user") {
      await this.ctx.db
        .update(desktopTakeovers)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(desktopTakeovers.id, row!.id));
      session.putItem(this.requestItem(row!, "taken"));
    } else {
      session.putItem(this.requestItem(row!, "pending"));
    }
    await createNotification(this.ctx, {
      kind: "takeover_request",
      title: `${session.bot.name} needs you to take over`,
      body: input.reason,
      botId: session.bot.id,
      chatId: session.chat.id,
      runId: session.run.id,
    });
    await publishApp(this.ctx, { type: "takeovers" });

    return session.whileWaiting(
      "takeover",
      () =>
        new Promise<TakeoverWaitResult>((resolve) => {
          const timer = setTimeout(() => {
            this.waiters.delete(row!.id);
            resolve({ status: "pending" });
          }, REQUEST_WAIT_MS);
          this.waiters.set(row!.id, {
            runId: session.run.id,
            resolve: (result) => {
              clearTimeout(timer);
              this.waiters.delete(row!.id);
              resolve(result);
            },
          });
        }),
    );
  }

  /** The run ended: stop waiting for it, so handing back later starts a new run instead. */
  releaseRun(runId: string): void {
    for (const waiter of [...this.waiters.values()])
      if (waiter.runId === runId) waiter.resolve({ status: "pending" });
  }

  /** You take control of a bot's screen. That bot stops using it until you hand it back. */
  async take(screenId: string): Promise<void> {
    const { previous } = await this.ctx.computer.takeByUser(screenId);
    const now = new Date();
    const onScreen = eq(desktopTakeovers.screenId, screenId);
    const pending = await this.ctx.db
      .update(desktopTakeovers)
      .set({ status: "active", startedAt: now })
      .where(and(eq(desktopTakeovers.status, "requested"), onScreen))
      .returning();
    const [active] = await this.ctx.db
      .select()
      .from(desktopTakeovers)
      .where(and(eq(desktopTakeovers.status, "active"), onScreen))
      .orderBy(desc(desktopTakeovers.createdAt))
      .limit(1);
    const interruptedRunId = previous?.kind === "run" ? previous.runId : null;
    if (!active) {
      await this.ctx.db
        .insert(desktopTakeovers)
        .values({ screenId, status: "active", startedAt: now, interruptedRunId });
    } else if (interruptedRunId && !active.interruptedRunId) {
      await this.ctx.db
        .update(desktopTakeovers)
        .set({ interruptedRunId })
        .where(eq(desktopTakeovers.id, active.id));
    }
    for (const row of pending) await this.writeRequestItem(row, this.requestItem(row, "taken"));
    await publishApp(this.ctx, { type: "takeovers" });
    await publishApp(this.ctx, { type: "lease" });
  }

  /** You hand a screen back, optionally with a note for its bot. */
  async handBack(screenId: string, note: string | null): Promise<void> {
    this.handingBack.add(screenId);
    try {
      await this.ctx.computer.releaseByUser(screenId, "handed_back");
      await this.finishActive(screenId, note?.trim() || null, "handed_back");
    } finally {
      this.handingBack.delete(screenId);
    }
  }

  /** Dismiss a bot's request without taking over. */
  async dismiss(takeoverId: string): Promise<void> {
    const [row] = await this.ctx.db
      .update(desktopTakeovers)
      .set({ status: "dismissed", endedAt: new Date() })
      .where(and(eq(desktopTakeovers.id, takeoverId), eq(desktopTakeovers.status, "requested")))
      .returning();
    if (!row) return;
    await this.writeRequestItem(row, this.requestItem(row, "dismissed"));
    this.waiters.get(row.id)?.resolve({ status: "dismissed" });
    await publishApp(this.ctx, { type: "takeovers" });
  }

  private async finishActive(
    screenId: string,
    note: string | null,
    reason: TakeoverEndReason,
  ): Promise<void> {
    const ended = await this.ctx.db
      .update(desktopTakeovers)
      .set({ status: "ended", endedAt: new Date(), note, endReason: reason })
      .where(and(eq(desktopTakeovers.status, "active"), eq(desktopTakeovers.screenId, screenId)))
      .returning();
    const effectiveNote = reason === "handed_back" ? note : AUTO_NOTES[reason];
    const delivered = new Set<string>();

    // 1. Bots that asked you to take over get your note as the answer to their request.
    for (const row of ended.filter((r) => r.requestedByRunId)) {
      await this.writeRequestItem(row, this.requestItem(row, "handed_back", effectiveNote));
      const waiter = this.waiters.get(row.id);
      if (waiter) {
        waiter.resolve({ status: "handed_back", note: effectiveNote });
        delivered.add(row.requestedByRunId!);
      } else if (row.requestedByBotId) {
        const [run] = await this.ctx.db
          .select()
          .from(runs)
          .where(eq(runs.id, row.requestedByRunId!));
        if (run && !this.sessions.find(run.chatId, run.botId)) {
          await enqueueRun(this.ctx, {
            chatId: run.chatId,
            botId: run.botId,
            trigger: "hand_back",
            prompt: `[The user handed your screen back after your request: "${row.reason}".]${effectiveNote ? ` Their note: "${effectiveNote}".` : ""} Take a screenshot and continue the task.`,
            parentRunId: run.id,
          });
          delivered.add(run.id);
        }
      }
    }

    // 2. A run you interrupted by taking over continues.
    const interrupted = [
      ...new Set(ended.map((row) => row.interruptedRunId).filter(Boolean)),
    ] as string[];
    for (const runId of interrupted) {
      if (delivered.has(runId)) continue;
      const message = `[The user handed your screen back.]${effectiveNote ? ` Their note: "${effectiveNote}".` : ""} You may use the desktop again. Take a screenshot to see what changed, then continue.`;
      const session = this.sessions.get(runId);
      if (session) {
        const steered = await session.steer(`handback-${Date.now()}`, message, {
          text: effectiveNote ?? "",
          variant: "hand_back",
        });
        if (steered) continue;
      }
      const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, runId));
      if (run && !isRunActive(run.status) && !this.sessions.find(run.chatId, run.botId)) {
        await enqueueRun(this.ctx, {
          chatId: run.chatId,
          botId: run.botId,
          trigger: "hand_back",
          prompt: `${message} Continue the task you were doing when the user took over.`,
          parentRunId: run.id,
        });
      }
    }
    await publishApp(this.ctx, { type: "takeovers" });
  }
}
