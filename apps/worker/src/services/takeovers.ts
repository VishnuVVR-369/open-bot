import { createHash, randomUUID } from "node:crypto";
import {
  bots,
  desktopTakeovers,
  runs,
  screenOperations,
  takeoverDeliveries,
  type TakeoverEndReason,
} from "@open-bot/db";
import {
  isOwnerLease,
  isRunActive,
  type LeaseHolder,
  type TakeoverRequestItem,
} from "@open-bot/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { ScreenBusy, withScreenLock } from "./screen-operations";

const REQUEST_WAIT_MS = 10 * 60_000;

/** The note a bot gets after "Type the code" submitted the code and the screen was verified safe. */
export const CODE_HANDED_BACK_NOTE = "Entered the code you sent and submitted it.";

/** One continuation per interrupted run within the same return, even with several requests. */
function continuationId(returnId: string, runId: string): string {
  const bytes = createHash("sha256").update(`${returnId}:${runId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
      if (isOwnerLease(previous) && !isOwnerLease(holder) && !this.handingBack.has(screenId)) {
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
    if (isOwnerLease(this.ctx.computer.lease(screenId))) {
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
      takeoverId: row!.id,
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
    await this.recordTake(screenId, previous);
  }

  /** Records that you hold the screen: its requests become active and an interrupted run is noted. */
  async recordTake(screenId: string, previous: LeaseHolder): Promise<void> {
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
  async handBack(screenId: string, note: string | null, clearCode = false): Promise<void> {
    this.handingBack.add(screenId);
    try {
      await this.ctx.db
        .update(desktopTakeovers)
        .set({ note: note?.trim() || null, endReason: "handed_back" })
        .where(and(eq(desktopTakeovers.status, "active"), eq(desktopTakeovers.screenId, screenId)));
      const { released } = await this.ctx.computer.releaseByUser(
        screenId,
        "handed_back",
        clearCode,
      );
      if (
        !released &&
        isOwnerLease(
          (await this.ctx.computer.fetchHealth()).screens.find((s) => s.id === screenId)?.lease ??
            null,
        )
      )
        throw new ScreenBusy("The code may still be visible. Clear the code before handing back.");
      await this.finishActive(screenId, note?.trim() || null, "handed_back");
    } finally {
      this.handingBack.delete(screenId);
    }
  }

  /** Dismiss a bot's request without taking over. Waits for no code entry on that screen. */
  async dismiss(takeoverId: string): Promise<void> {
    const [request] = await this.ctx.db
      .select({ screenId: desktopTakeovers.screenId })
      .from(desktopTakeovers)
      .where(eq(desktopTakeovers.id, takeoverId));
    if (!request) return;
    if (request.screenId)
      await withScreenLock(this.ctx, request.screenId, () => this.dismissNow(takeoverId));
    else await this.dismissNow(takeoverId);
  }

  private async dismissNow(takeoverId: string): Promise<void> {
    const [row] = await this.ctx.db
      .update(desktopTakeovers)
      .set({ status: "dismissed", endedAt: new Date() })
      .where(and(eq(desktopTakeovers.id, takeoverId), eq(desktopTakeovers.status, "requested")))
      .returning();
    if (!row) return;
    this.ctx.events.emit("takeoverEnded", row.id);
    await this.writeRequestItem(row, this.requestItem(row, "dismissed"));
    this.waiters.get(row.id)?.resolve({ status: "dismissed" });
    await publishApp(this.ctx, { type: "takeovers" });
  }

  private async finishActive(
    screenId: string,
    note: string | null,
    reason: TakeoverEndReason,
  ): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      // Every takeover ended together shares one return, so each bot hears about it once.
      const continuationRunId = randomUUID();
      const ended = await tx
        .update(desktopTakeovers)
        .set({ status: "ended", endedAt: new Date(), note, endReason: reason })
        .where(and(eq(desktopTakeovers.status, "active"), eq(desktopTakeovers.screenId, screenId)))
        .returning();
      for (const row of ended)
        await tx
          .insert(takeoverDeliveries)
          .values({ id: row.id, continuationRunId })
          .onConflictDoNothing();
    });
    await this.deliverReturns();
  }

  /**
   * Finishes what a worker restart or a partly failed hand-back left behind: an active takeover
   * whose screen you no longer hold, a code verified safe but not yet handed back, and screens
   * paused because a code may still be visible. Runs on startup and every 30 seconds.
   */
  async reconcile(): Promise<void> {
    if (this.ctx.computer.online) {
      const active = await this.ctx.db
        .select()
        .from(desktopTakeovers)
        .where(eq(desktopTakeovers.status, "active"));
      for (const row of active) {
        const screenId = row.screenId;
        if (!screenId) continue;
        try {
          await withScreenLock(this.ctx, screenId, async () => {
            const health = await this.ctx.computer.fetchHealth();
            if (!isOwnerLease(health.screens.find((s) => s.id === screenId)?.lease ?? null)) {
              await this.finishActive(screenId, row.note, row.endReason ?? "handed_back");
              return;
            }
            const [operation] = await this.ctx.db
              .select()
              .from(screenOperations)
              .where(
                and(eq(screenOperations.takeoverId, row.id), eq(screenOperations.status, "safe")),
              );
            if (!operation) return;
            try {
              await this.handBack(screenId, row.note ?? CODE_HANDED_BACK_NOTE);
            } catch (error) {
              if (!(error instanceof ScreenBusy)) throw error;
              await this.ctx.db
                .update(screenOperations)
                .set({ status: "needs_owner", reason: error.message, updatedAt: new Date() })
                .where(eq(screenOperations.id, operation.id));
            }
          });
        } catch (error) {
          if (!(error instanceof ScreenBusy)) throw error;
        }
      }
      await this.notifyPausedScreens();
    }
    // Once a takeover ended, its screen passed the safety check on the way back.
    await this.ctx.db
      .update(screenOperations)
      .set({ status: "handed_back", reason: null, updatedAt: new Date() })
      .where(
        and(
          inArray(screenOperations.status, ["safe", "needs_owner", "unknown"]),
          sql`${screenOperations.takeoverId} in (select id from desktop_takeovers where status = 'ended')`,
        ),
      );
    await this.deliverReturns();
  }

  /** Screens paused because your code may still be visible. You hear about each pause once. */
  private readonly pausedScreens = new Set<string>();

  private async notifyPausedScreens(): Promise<void> {
    const health = await this.ctx.computer.fetchHealth();
    const paused = new Set(
      health.screens
        .filter((s) => isOwnerLease(s.lease) && s.lease.pausedForSafety)
        .map((s) => s.id),
    );
    for (const id of this.pausedScreens) if (!paused.has(id)) this.pausedScreens.delete(id);
    for (const id of paused) {
      if (this.pausedScreens.has(id)) continue;
      const [bot] = await this.ctx.db.select({ name: bots.name }).from(bots).where(eq(bots.id, id));
      await createNotification(this.ctx, {
        kind: "takeover_request",
        title: `${bot?.name ?? "Your teammate"}'s screen is paused`,
        body: "Your code may still be visible. Open the computer to check.",
        botId: id,
        chatId: null,
        runId: null,
      });
      this.pausedScreens.add(id);
    }
  }

  private delivering = false;
  private deliverAgain = false;

  /** Tells bots about every ended takeover not yet delivered. Safe to call from anywhere. */
  private async deliverReturns(): Promise<void> {
    if (this.delivering) {
      this.deliverAgain = true;
      return;
    }
    this.delivering = true;
    try {
      do {
        this.deliverAgain = false;
        await this.deliverPendingReturns();
      } while (this.deliverAgain);
    } finally {
      this.delivering = false;
    }
  }

  private async deliverPendingReturns(): Promise<void> {
    const pending = await this.ctx.db
      .selectDistinct({ continuationRunId: takeoverDeliveries.continuationRunId })
      .from(takeoverDeliveries)
      .where(isNull(takeoverDeliveries.deliveredAt));
    for (const { continuationRunId } of pending) {
      try {
        // Another worker process may be delivering the same return.
        await withScreenLock(this.ctx, `return:${continuationRunId}`, async () => {
          const ended = (
            await this.ctx.db
              .select({ takeover: desktopTakeovers })
              .from(takeoverDeliveries)
              .innerJoin(desktopTakeovers, eq(desktopTakeovers.id, takeoverDeliveries.id))
              .where(
                and(
                  eq(takeoverDeliveries.continuationRunId, continuationRunId),
                  isNull(takeoverDeliveries.deliveredAt),
                ),
              )
          ).map((row) => row.takeover);
          if (!ended.length) return;
          await this.deliverReturn(ended, continuationRunId);
          for (const row of ended) this.ctx.events.emit("takeoverEnded", row.id);
          await this.ctx.db
            .update(takeoverDeliveries)
            .set({ deliveredAt: new Date() })
            .where(eq(takeoverDeliveries.continuationRunId, continuationRunId));
        });
      } catch (error) {
        if (!(error instanceof ScreenBusy)) throw error;
      }
    }
  }

  private async deliverReturn(
    ended: (typeof desktopTakeovers.$inferSelect)[],
    continuationRunId: string,
  ): Promise<void> {
    // Rows ended together share the same note and reason.
    const note = ended[0]!.note;
    const reason = ended[0]!.endReason ?? "handed_back";
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
            id: continuationId(continuationRunId, run.id),
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
        const steered = await session.steer(`handback-${continuationRunId}`, message, {
          text: effectiveNote ?? "",
          variant: "hand_back",
        });
        if (steered) continue;
      }
      const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, runId));
      if (run && !isRunActive(run.status) && !this.sessions.find(run.chatId, run.botId)) {
        await enqueueRun(this.ctx, {
          id: continuationId(continuationRunId, run.id),
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
