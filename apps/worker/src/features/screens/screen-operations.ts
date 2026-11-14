import { screenTakeovers, screenOperations, type Queryable } from "@open-bot/db";
import {
  isOwnerLease,
  type ScreenOperation,
  type ScreenOperationStatus,
  type TypeOnScreen,
} from "@open-bot/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BotdError } from "../../computer/client";
import { publishApp, type Context } from "../../context";
import { ScreenBusy, withScreenLock } from "./screen-lock";
import { CODE_HANDED_BACK_NOTE, type TakeoverService } from "./takeovers";

/** Statuses botd answers before a handler runs: bad input, no token, no such route. */
const REFUSED_BEFORE_ACTING = [400, 401, 403, 404];

/** An operation's screen couldn't be handed back now: you need to look at it, for this reason. */
export async function operationNeedsOwner(
  db: Queryable,
  operationId: string,
  reason: string,
): Promise<void> {
  await db
    .update(screenOperations)
    .set({ status: "needs_owner", reason, updatedAt: new Date() })
    .where(eq(screenOperations.id, operationId));
}

/** Operations whose takeover ended: their screen passed the safety check on the way back. */
export async function handBackEndedOperations(db: Queryable): Promise<void> {
  await db
    .update(screenOperations)
    .set({ status: "handed_back", reason: null, updatedAt: new Date() })
    .where(
      and(
        inArray(screenOperations.status, ["safe", "needs_owner", "unknown"]),
        sql`${screenOperations.takeoverId} in (select id from desktop_takeovers where status = 'ended')`,
      ),
    );
}

export class ScreenOperationService {
  constructor(
    private readonly ctx: Context,
    private readonly takeovers: TakeoverService,
  ) {}

  async recover(): Promise<void> {
    await this.ctx.db
      .update(screenOperations)
      .set({
        status: "unknown",
        reason: "The worker restarted. Check the screen before sending again.",
        updatedAt: new Date(),
      })
      .where(inArray(screenOperations.status, ["received", "typing", "typed", "verifying"]));
  }

  async get(id: string): Promise<ScreenOperation | null> {
    const [row] = await this.ctx.db
      .select()
      .from(screenOperations)
      .where(eq(screenOperations.id, id));
    return row ?? null;
  }

  async cancel(id: string): Promise<ScreenOperation> {
    await this.ctx.db
      .insert(screenOperations)
      .values({ id, status: "cancelled" })
      .onConflictDoNothing();
    return (await this.get(id))!;
  }

  private async set(
    id: string,
    status: ScreenOperationStatus,
    reason: string | null = null,
  ): Promise<ScreenOperation> {
    await this.ctx.db
      .update(screenOperations)
      .set({ status, reason, updatedAt: new Date() })
      .where(eq(screenOperations.id, id));
    await publishApp(this.ctx, { type: "takeovers" });
    return (await this.get(id))!;
  }

  async context(takeoverId: string): Promise<{ screenId: string; site: string | null }> {
    const [request] = await this.ctx.db
      .select()
      .from(screenTakeovers)
      .where(eq(screenTakeovers.id, takeoverId));
    if (
      !request?.screenId ||
      request.status !== "requested" ||
      Date.now() - request.createdAt.getTime() >= 600_000
    )
      throw new ScreenBusy("This takeover request ended or expired.");
    return {
      screenId: request.screenId,
      ...(await this.ctx.computer.codeContext(request.screenId)),
    };
  }

  async type(input: TypeOnScreen): Promise<ScreenOperation> {
    // This insert is deliberately the first effect. A cancelled tombstone always wins.
    const [inserted] = await this.ctx.db
      .insert(screenOperations)
      .values({ id: input.operationId, status: "received" })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return (await this.get(input.operationId))!;
    try {
      const [request] = await this.ctx.db
        .select()
        .from(screenTakeovers)
        .where(eq(screenTakeovers.id, input.takeoverId));
      if (!request?.screenId)
        return this.set(input.operationId, "failed", "That takeover request is gone.");
      const screenId = request.screenId;
      await this.ctx.db
        .update(screenOperations)
        .set({ takeoverId: request.id, screenId })
        .where(eq(screenOperations.id, input.operationId));
      return await withScreenLock(this.ctx, screenId, async () => {
        const [current] = await this.ctx.db
          .select()
          .from(screenTakeovers)
          .where(eq(screenTakeovers.id, request.id));
        if (
          !current ||
          current.status !== "requested" ||
          Date.now() - current.createdAt.getTime() >= 600_000
        )
          return this.set(
            input.operationId,
            "failed",
            "The request ended or expired. Nothing was typed.",
          );
        const health = await this.ctx.computer.fetchHealth();
        const previous = health.screens.find((s) => s.id === screenId)?.lease ?? null;
        if (isOwnerLease(previous))
          return this.set(
            input.operationId,
            "failed",
            "You already hold this screen. Nothing was typed.",
          );
        const { site } = await this.ctx.computer.codeContext(screenId);
        if (!site || site !== input.expectedSite.toLowerCase())
          return this.set(
            input.operationId,
            "failed",
            "The site or focused field changed. Nothing was typed.",
          );
        await this.set(input.operationId, "typing");
        let result: Awaited<ReturnType<Context["computer"]["typeOnScreen"]>>;
        try {
          result = await this.ctx.computer.typeOnScreen(screenId, input);
        } catch (error) {
          // botd refused the call before acting on it, like a computer on another version (404).
          if (error instanceof BotdError && REFUSED_BEFORE_ACTING.includes(error.status))
            return this.set(
              input.operationId,
              "failed",
              "The computer refused it, so nothing was typed. If it is being updated, send it again in a few minutes.",
            );
          // botd may hold the screen for you now. Record the takeover so handing back reaches
          // the teammate; if you don't hold it, the reconciler ends it.
          await this.takeovers.recordTake(screenId, previous);
          return this.set(
            input.operationId,
            "unknown",
            "Outcome unknown. Check the screen before sending again.",
          );
        }
        // Refused: botd released anything it took and nothing was typed, so the request stays open.
        if (result.status === "failed") return this.set(input.operationId, "failed", result.reason);
        await this.takeovers.recordTake(screenId, result.previous ?? previous);
        await this.set(input.operationId, "typed");
        await this.set(input.operationId, "verifying");
        await this.set(input.operationId, result.status, result.reason);
        if (result.status === "safe") {
          try {
            await this.takeovers.handBack(screenId, CODE_HANDED_BACK_NOTE);
            return this.set(input.operationId, "handed_back");
          } catch (error) {
            if (error instanceof ScreenBusy)
              return this.set(input.operationId, "needs_owner", error.message);
            return this.set(
              input.operationId,
              "safe",
              "Control returned or is being checked; letting your teammate know.",
            );
          }
        }
        return (await this.get(input.operationId))!;
      });
    } catch (error) {
      // Never serialize an upstream error: it could contain the secret request body.
      return this.set(
        input.operationId,
        error instanceof ScreenBusy ? "failed" : "unknown",
        error instanceof ScreenBusy
          ? error.message
          : "Outcome unknown. Check the screen before sending again.",
      );
    }
  }
}
