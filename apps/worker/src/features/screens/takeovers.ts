import { createHash, randomUUID } from "node:crypto";
import {
  teammates,
  screenTakeovers,
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
} from "@open-bot/domain";
import { and, desc, eq, inArray, isNull, min, sql } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { createNotification } from "../notifications";
import { enqueueRun } from "../../runs/queue";
import { appendRunEvent } from "../../runs/events";
import { errorMessage } from "../../logger";
import type { RunSession } from "../../runs/session";
import type { SessionRegistry } from "../../runs/registry";
import { ScreenBusy, withScreenLock } from "./screen-lock";
import { handBackEndedOperations, operationNeedsOwner } from "./screen-operations";

const REQUEST_WAIT_MS = 10 * 60_000;

/** The note a teammate gets after "Type the code" submitted the code and the screen was verified safe. */
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
  user_disconnected: "Control came back automatically because the user's screen view disconnected.",
};

/**
 * What the teammate hears about how its screen came back. A note you saved with a hand-back botd
 * refused (a computer on another version answers 404) stays yours when control then comes back on
 * its own, so it is delivered with the reason.
 */
function returnNote(note: string | null, reason: TakeoverEndReason): string | null {
  if (reason === "handed_back") return note;
  if (!note) return AUTO_NOTES[reason];
  return `${AUTO_NOTES[reason]} Before that, they tried to hand it back with this note: ${note}`;
}

type TakeoverRow = typeof screenTakeovers.$inferSelect;

/** Oldest first, so the same takeovers are read in the same order every time. */
function byCreation(a: TakeoverRow, b: TakeoverRow): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * The note of takeovers that share a screen and come back together. A hand-back saves its note on
 * every active takeover of the screen, so the note belongs to all of them: one without a note is a
 * request that joined after it was saved, and must not hide it. Each save writes every active row,
 * so the newest row with a note holds the newest save; that one wins if notes ever differ, since
 * the owner replaced the older one.
 */
function groupNote(rows: TakeoverRow[]): string | null {
  return rows.toSorted(byCreation).findLast((row) => row.note)?.note ?? null;
}

/** Why takeovers ended together came back: one update ends them all with the same reason. */
function groupReason(rows: TakeoverRow[]): TakeoverEndReason {
  return (
    rows.find((row) => row.endReason && row.endReason !== "handed_back")?.endReason ?? "handed_back"
  );
}

/**
 * You taking control of a teammate's screen, handing it back, and teammates asking you to take over.
 * Every teammate has its own screen, so a takeover stops only that teammate; the others keep working.
 * botd owns the leases; this service records takeovers and tells the teammates what happened.
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
        // A note a hand-back saved before botd refused it (a computer on another version) stays:
        // the lease then ends here, when the computer restarts or you go idle or disconnect, and
        // `returnNote` delivers the note with the reason.
        const ending = reason === "user_idle" || reason === "user_disconnected" ? { reason } : {};
        void this.finishActive(screenId, ending).catch((error: unknown) =>
          ctx.log.error("could not finish a takeover", { error: errorMessage(error) }),
        );
      }
      void publishApp(ctx, { type: "lease" });
    });
  }

  private requestItem(
    row: typeof screenTakeovers.$inferSelect,
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
    row: typeof screenTakeovers.$inferSelect,
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

  /** A teammate asks you to take over its screen. Waits up to 10 minutes for you to hand back. */
  async requestFromTeammate(
    session: RunSession,
    input: { reason: string; itemId: string },
  ): Promise<TakeoverWaitResult> {
    const screenId = session.teammate.id;
    const [row] = await this.ctx.db
      .insert(screenTakeovers)
      .values({
        screenId,
        status: "requested",
        requestedByRunId: session.run.id,
        requestedByTeammateId: session.teammate.id,
        reason: input.reason,
        itemId: input.itemId,
      })
      .returning();
    // If you already have control of this screen, the request joins your current takeover.
    if (isOwnerLease(this.ctx.computer.lease(screenId))) {
      await this.ctx.db
        .update(screenTakeovers)
        .set({ status: "active", startedAt: new Date() })
        .where(and(eq(screenTakeovers.id, row!.id), eq(screenTakeovers.status, "requested")));
      session.putItem(this.requestItem(row!, "taken"));
    } else {
      session.putItem(this.requestItem(row!, "pending"));
    }
    await createNotification(this.ctx, {
      kind: "takeover_request",
      title: `${session.teammate.name} needs you to take over`,
      body: input.reason,
      teammateId: session.teammate.id,
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

  /** You take control of a teammate's screen. That teammate stops using it until you hand it back. */
  async take(screenId: string): Promise<void> {
    const { previous } = await this.ctx.computer.takeByUser(screenId);
    await this.recordTake(screenId, previous);
  }

  /** Records that you hold the screen: its requests become active and an interrupted run is noted. */
  async recordTake(screenId: string, previous: LeaseHolder): Promise<void> {
    const now = new Date();
    const onScreen = eq(screenTakeovers.screenId, screenId);
    const pending = await this.ctx.db
      .update(screenTakeovers)
      .set({ status: "active", startedAt: now })
      .where(and(eq(screenTakeovers.status, "requested"), onScreen))
      .returning();
    const [active] = await this.ctx.db
      .select()
      .from(screenTakeovers)
      .where(and(eq(screenTakeovers.status, "active"), onScreen))
      .orderBy(desc(screenTakeovers.createdAt))
      .limit(1);
    const interruptedRunId = previous?.kind === "run" ? previous.runId : null;
    if (!active) {
      await this.ctx.db
        .insert(screenTakeovers)
        .values({ screenId, status: "active", startedAt: now, interruptedRunId });
    } else if (interruptedRunId) {
      // Only an active takeover without one: the row decides, not what was read above.
      await this.ctx.db
        .update(screenTakeovers)
        .set({ interruptedRunId })
        .where(
          and(
            eq(screenTakeovers.id, active.id),
            eq(screenTakeovers.status, "active"),
            isNull(screenTakeovers.interruptedRunId),
          ),
        );
    }
    for (const row of pending) await this.writeRequestItem(row, this.requestItem(row, "taken"));
    await publishApp(this.ctx, { type: "takeovers" });
    await publishApp(this.ctx, { type: "lease" });
  }

  /** You hand a screen back, optionally with a note for its teammate. */
  async handBack(screenId: string, note: string | null, clearCode = false): Promise<void> {
    this.handingBack.add(screenId);
    try {
      await this.ctx.db
        .update(screenTakeovers)
        .set({ note: note?.trim() || null, endReason: "handed_back" })
        .where(and(eq(screenTakeovers.status, "active"), eq(screenTakeovers.screenId, screenId)));
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
      await this.finishActive(screenId, { note: note?.trim() || null, reason: "handed_back" });
    } finally {
      this.handingBack.delete(screenId);
    }
  }

  /** Dismiss a teammate's request without taking over. Waits for no code entry on that screen. */
  async dismiss(takeoverId: string): Promise<void> {
    const [request] = await this.ctx.db
      .select({ screenId: screenTakeovers.screenId })
      .from(screenTakeovers)
      .where(eq(screenTakeovers.id, takeoverId));
    if (!request) return;
    if (request.screenId)
      await withScreenLock(this.ctx, request.screenId, () => this.dismissNow(takeoverId));
    else await this.dismissNow(takeoverId);
  }

  private async dismissNow(takeoverId: string): Promise<void> {
    const [row] = await this.ctx.db
      .update(screenTakeovers)
      .set({ status: "dismissed", endedAt: new Date() })
      .where(and(eq(screenTakeovers.id, takeoverId), eq(screenTakeovers.status, "requested")))
      .returning();
    if (!row) return;
    this.ctx.events.emit("takeoverEnded", row.id);
    await this.writeRequestItem(row, this.requestItem(row, "dismissed"));
    this.waiters.get(row.id)?.resolve({ status: "dismissed" });
    await publishApp(this.ctx, { type: "takeovers" });
  }

  /**
   * Ends the screen's active takeovers. `ending` holds only what the caller learned just now: your
   * note from the hand-back you just made, or the reason botd gave. Everything else is the row's
   * own, read by this same update under its row lock, so a note saved after the caller looked
   * (a hand-back botd refused) is never overwritten with an older value.
   */
  private async finishActive(
    screenId: string,
    ending: { note?: string | null; reason?: TakeoverEndReason } = {},
  ): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      // Every takeover ended together shares one return, so each teammate hears about it once.
      const continuationRunId = randomUUID();
      const ended = await tx
        .update(screenTakeovers)
        .set({
          status: "ended",
          endedAt: new Date(),
          ...(ending.note !== undefined && { note: ending.note }),
          endReason: ending.reason ?? sql`coalesce(${screenTakeovers.endReason}, 'handed_back')`,
        })
        .where(and(eq(screenTakeovers.status, "active"), eq(screenTakeovers.screenId, screenId)))
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
      // Only which screens to look at: each takeover is read again under its screen's lock, since
      // a hand-back may save its note in between.
      const screens = await this.ctx.db
        .selectDistinct({ screenId: screenTakeovers.screenId })
        .from(screenTakeovers)
        .where(eq(screenTakeovers.status, "active"))
        .orderBy(screenTakeovers.screenId);
      for (const { screenId } of screens) {
        if (!screenId) continue;
        try {
          await withScreenLock(this.ctx, screenId, async () => {
            const health = await this.ctx.computer.fetchHealth();
            if (!isOwnerLease(health.screens.find((s) => s.id === screenId)?.lease ?? null)) {
              await this.finishActive(screenId);
              return;
            }
            const rows = await this.ctx.db
              .select()
              .from(screenTakeovers)
              .where(
                and(eq(screenTakeovers.status, "active"), eq(screenTakeovers.screenId, screenId)),
              )
              .orderBy(screenTakeovers.createdAt, screenTakeovers.id);
            if (!rows.length) return;
            const [operation] = await this.ctx.db
              .select()
              .from(screenOperations)
              .where(
                and(
                  inArray(
                    screenOperations.takeoverId,
                    rows.map((row) => row.id),
                  ),
                  eq(screenOperations.status, "safe"),
                ),
              )
              .orderBy(screenOperations.createdAt, screenOperations.id)
              .limit(1);
            if (!operation) return;
            try {
              // A note you saved on any of them stays yours, even on the request the code was for.
              await this.handBack(screenId, groupNote(rows) ?? CODE_HANDED_BACK_NOTE);
            } catch (error) {
              if (!(error instanceof ScreenBusy)) throw error;
              await operationNeedsOwner(this.ctx.db, operation.id, error.message);
            }
          });
        } catch (error) {
          if (!(error instanceof ScreenBusy)) throw error;
        }
      }
      await this.notifyPausedScreens();
    }
    // Once a takeover ended, its screen passed the safety check on the way back.
    await handBackEndedOperations(this.ctx.db);
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
      const [teammate] = await this.ctx.db
        .select({ name: teammates.name })
        .from(teammates)
        .where(eq(teammates.id, id));
      await createNotification(this.ctx, {
        kind: "takeover_request",
        title: `${teammate?.name ?? "Your teammate"}'s screen is paused`,
        body: "Your code may still be visible. Open the computer to check.",
        teammateId: id,
        chatId: null,
        runId: null,
      });
      this.pausedScreens.add(id);
    }
  }

  private delivering = false;
  private deliverAgain = false;

  /** Tells teammates about every ended takeover not yet delivered. Safe to call from anywhere. */
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
    // Oldest return first.
    const pending = await this.ctx.db
      .select({ continuationRunId: takeoverDeliveries.continuationRunId })
      .from(takeoverDeliveries)
      .where(isNull(takeoverDeliveries.deliveredAt))
      .groupBy(takeoverDeliveries.continuationRunId)
      .orderBy(min(takeoverDeliveries.createdAt), takeoverDeliveries.continuationRunId);
    for (const { continuationRunId } of pending) {
      try {
        // Another worker process may be delivering the same return.
        await withScreenLock(this.ctx, `return:${continuationRunId}`, async () => {
          const ended = (
            await this.ctx.db
              .select({ takeover: screenTakeovers })
              .from(takeoverDeliveries)
              .innerJoin(screenTakeovers, eq(screenTakeovers.id, takeoverDeliveries.id))
              .where(
                and(
                  eq(takeoverDeliveries.continuationRunId, continuationRunId),
                  isNull(takeoverDeliveries.deliveredAt),
                ),
              )
              .orderBy(screenTakeovers.createdAt, screenTakeovers.id)
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

  private async deliverReturn(ended: TakeoverRow[], continuationRunId: string): Promise<void> {
    // Every takeover in the return gets the group's note, whichever of them saved it.
    const effectiveNote = returnNote(groupNote(ended), groupReason(ended));
    const delivered = new Set<string>();

    // 1. Teammates that asked you to take over get your note as the answer to their request.
    for (const row of ended.filter((r) => r.requestedByRunId)) {
      await this.writeRequestItem(row, this.requestItem(row, "handed_back", effectiveNote));
      const waiter = this.waiters.get(row.id);
      if (waiter) {
        waiter.resolve({ status: "handed_back", note: effectiveNote });
        delivered.add(row.requestedByRunId!);
      } else if (row.requestedByTeammateId) {
        const [run] = await this.ctx.db
          .select()
          .from(runs)
          .where(eq(runs.id, row.requestedByRunId!));
        if (run && !this.sessions.find(run.chatId, run.teammateId)) {
          await enqueueRun(this.ctx, {
            id: continuationId(continuationRunId, run.id),
            chatId: run.chatId,
            teammateId: run.teammateId,
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
      if (run && !isRunActive(run.status) && !this.sessions.find(run.chatId, run.teammateId)) {
        await enqueueRun(this.ctx, {
          id: continuationId(continuationRunId, run.id),
          chatId: run.chatId,
          teammateId: run.teammateId,
          trigger: "hand_back",
          prompt: `${message} Continue the task you were doing when the user took over.`,
          parentRunId: run.id,
        });
      }
    }
    await publishApp(this.ctx, { type: "takeovers" });
  }
}
