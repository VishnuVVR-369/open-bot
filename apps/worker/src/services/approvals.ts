import {
  approvalRules,
  approvals,
  configurationRevision,
  purchases,
  type ApprovalKind,
} from "@open-bot/db";
import type { RuleKind } from "@open-bot/shared";
import {
  formatMoney,
  invalidRulePattern,
  PURCHASE_WINDOW_MS,
  rulesCover,
  type ApprovalItem,
} from "@open-bot/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  appendRunEvent,
  createNotification,
  enqueueRun,
  publishApp,
  type Context,
} from "../context";
import type { RunSession } from "../runs/session";
import type { SessionRegistry } from "./registry";

const ACTION_WAIT_MS = 10 * 60_000;

type Decision = "approved" | "denied";

type Rule = typeof approvalRules.$inferSelect;

/**
 * Approval requests: Codex's own (commands and file changes, which wait as long as the turn lives)
 * and the bots' request_approval tool (which waits up to 10 minutes, then continues in a new run).
 */
export class ApprovalService {
  /** Runs waiting for a decision, by approval id. */
  private readonly waiters = new Map<
    string,
    { runId: string; resolve: (decision: Decision | "pending") => void }
  >();

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionRegistry,
  ) {}

  private async create(
    session: RunSession,
    input: {
      kind: ApprovalKind;
      title: string;
      detail: string;
      itemId: string;
      subject?: string;
      /** No "always allow": this kind of change is asked about every time. */
      askEveryTime?: boolean;
      payload?: Record<string, unknown>;
    },
  ): Promise<string> {
    const [row] = await this.ctx.db
      .insert(approvals)
      .values({
        runId: session.run.id,
        botId: session.bot.id,
        chatId: session.chat.id,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        payload: {
          ...input.payload,
          ...(input.subject ? { subject: input.subject } : {}),
          ...(input.askEveryTime ? { askEveryTime: true } : {}),
        },
        itemId: input.itemId,
      })
      .returning({ id: approvals.id });
    const approvalId = row!.id;
    session.putItem({
      id: input.itemId,
      kind: "approval",
      approvalId,
      approvalKind: input.kind,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.askEveryTime ? { askEveryTime: true } : {}),
      title: input.title,
      detail: input.detail,
      decision: "pending",
      status: "running",
      startedAt: session.now(),
    });
    await createNotification(this.ctx, {
      kind: "approval",
      title: `${session.bot.name} needs your approval`,
      body: input.title,
      botId: session.bot.id,
      chatId: session.chat.id,
      runId: session.run.id,
      approvalId,
    });
    await publishApp(this.ctx, { type: "approvals" });
    return approvalId;
  }

  private wait(
    runId: string,
    approvalId: string,
    timeoutMs?: number,
  ): Promise<Decision | "pending"> {
    return new Promise((resolve) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.waiters.delete(approvalId);
            resolve("pending");
          }, timeoutMs)
        : null;
      this.waiters.set(approvalId, {
        runId,
        resolve: (decision) => {
          if (timer) clearTimeout(timer);
          this.waiters.delete(approvalId);
          resolve(decision);
        },
      });
    });
  }

  /** The run ended: its waits are over, so later decisions start a new run instead. */
  releaseRun(runId: string): void {
    for (const waiter of [...this.waiters.values()])
      if (waiter.runId === runId) waiter.resolve("pending");
  }

  /** The bot's "always allow" rules. */
  rulesFor(botId: string): Promise<Rule[]> {
    return this.ctx.db.select().from(approvalRules).where(eq(approvalRules.botId, botId));
  }

  private async allowedByRule(botId: string, kind: RuleKind, text: string) {
    return rulesCover(await this.rulesFor(botId), kind, text);
  }

  async requestNative(
    session: RunSession,
    input: {
      kind: "command" | "file_change";
      title: string;
      detail: string;
      itemId: string;
      subject?: string;
    },
  ): Promise<boolean> {
    if (await this.allowedByRule(session.bot.id, input.kind, input.subject ?? input.title))
      return true;
    const approvalId = await this.create(session, input);
    const decision = await session.whileWaiting("approval", () =>
      this.wait(session.run.id, approvalId),
    );
    return decision === "approved";
  }

  /**
   * Ask before an action the bot describes. An "always allow" rule for `subject` (or the title)
   * skips the question, except with `askEveryTime`, which permission grants use.
   *
   * With `operation`, the approval belongs to that exact tool call. When it is decided after the
   * bot stopped waiting, the follow-up run may repeat the call once without asking again.
   */
  async requestAction(
    session: RunSession,
    input: {
      title: string;
      detail: string;
      itemId: string;
      subject?: string;
      askEveryTime?: boolean;
      operation?: { tool: string; arguments: Record<string, unknown> };
    },
  ): Promise<Decision | "pending"> {
    const { askEveryTime, operation, ...details } = input;
    const operationKey = operation ? configurationRevision(operation) : null;
    if (operationKey && (await this.consumeLateApproval(session, operationKey))) return "approved";
    if (
      !askEveryTime &&
      (await this.allowedByRule(session.bot.id, "action", input.subject ?? input.title))
    )
      return "approved";
    const approvalId = await this.create(session, {
      kind: "action",
      ...details,
      ...(askEveryTime ? { askEveryTime } : {}),
      ...(operation ? { payload: { operation, operationKey } } : {}),
    });
    const decision = await session.whileWaiting("approval", () =>
      this.wait(session.run.id, approvalId, ACTION_WAIT_MS),
    );
    // Used up here, so the follow-up run can't repeat it.
    if (decision === "approved" && operation)
      await this.ctx.db
        .update(approvals)
        .set({ payload: sql`${approvals.payload} || '{"consumed":true}'::jsonb` })
        .where(eq(approvals.id, approvalId));
    return decision;
  }

  /** An approval given after its run stopped waiting, used once by the run it started. */
  private async consumeLateApproval(session: RunSession, operationKey: string): Promise<boolean> {
    if (session.run.trigger !== "approval" || !session.run.parentRunId) return false;
    const [receipt] = await this.ctx.db
      .update(approvals)
      .set({ payload: sql`${approvals.payload} || '{"consumed":true}'::jsonb` })
      .where(
        and(
          eq(approvals.runId, session.run.parentRunId),
          eq(approvals.botId, session.bot.id),
          eq(approvals.chatId, session.chat.id),
          eq(approvals.status, "approved"),
          sql`${approvals.payload}->>'operationKey' = ${operationKey}`,
          sql`coalesce(${approvals.payload}->>'consumed', 'false') = 'false'`,
        ),
      )
      .returning({ id: approvals.id });
    return Boolean(receipt);
  }

  /**
   * Ask without waiting: what was asked about happens when you decide, even long after the run
   * ended. Returns the approval's id; `approvalDecided` tells its owner the decision.
   */
  async requestDeferred(
    session: RunSession,
    input: {
      kind: "email";
      title: string;
      detail: string;
      itemId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    return this.create(session, input);
  }

  /** A purchase over the teammate's auto-approve amount. No rule covers it, so it always asks. */
  async requestPurchase(
    session: RunSession,
    input: { purchaseId: string; title: string; detail: string; itemId: string },
  ): Promise<Decision | "pending"> {
    const approvalId = await this.create(session, {
      kind: "purchase",
      title: input.title,
      detail: input.detail,
      itemId: input.itemId,
    });
    await this.ctx.db
      .update(purchases)
      .set({ approvalId })
      .where(eq(purchases.id, input.purchaseId));
    return session.whileWaiting("approval", () =>
      this.wait(session.run.id, approvalId, ACTION_WAIT_MS),
    );
  }

  /**
   * Record your decision and deliver it to the bot. Returns false if it was already decided.
   * With `alwaysAllow`, approving also saves a rule, so the bot won't ask about this again.
   */
  async decide(
    approvalId: string,
    decision: Decision,
    alwaysAllow?: { pattern: string },
  ): Promise<boolean> {
    const [row] = await this.ctx.db
      .update(approvals)
      .set({ status: decision, decidedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!row) return false;
    if (
      decision === "approved" &&
      alwaysAllow &&
      row.kind !== "purchase" &&
      row.kind !== "email" &&
      row.payload.askEveryTime !== true
    ) {
      await this.addRule(row.botId, row.kind, alwaysAllow.pattern);
    }
    // An approved purchase opens its card to the teammate for a while.
    const [purchase] =
      row.kind === "purchase"
        ? await this.ctx.db
            .update(purchases)
            .set({
              status: decision,
              fillableUntil:
                decision === "approved" ? new Date(Date.now() + PURCHASE_WINDOW_MS) : null,
            })
            .where(and(eq(purchases.approvalId, row.id), eq(purchases.status, "pending")))
            .returning()
        : [];
    if (purchase) await publishApp(this.ctx, { type: "purchases" });

    const item: ApprovalItem = {
      id: row.itemId,
      kind: "approval",
      approvalId: row.id,
      approvalKind: row.kind,
      ...(typeof row.payload.subject === "string" ? { subject: row.payload.subject } : {}),
      title: row.title,
      detail: row.detail,
      decision,
      status: "completed",
      startedAt: row.createdAt.toISOString(),
      completedAt: new Date().toISOString(),
    };
    const session = this.sessions.get(row.runId);
    if (session) session.putItem(item);
    else await appendRunEvent(this.ctx, row.runId, row.chatId, { type: "item", item });

    this.ctx.events.emit("approvalDecided", row.id);
    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      waiter.resolve(decision);
    } else if (row.kind === "action" || row.kind === "purchase") {
      // The bot stopped waiting, so tell it in a new run.
      const approved = purchase
        ? `[Approval] The user approved the purchase: "${row.title}" (purchase ${purchase.id}, ${formatMoney(purchase.amountCents)}). Its card can be filled with vault_fill for the next 30 minutes. Go ahead, call finish_purchase when checkout is done, then report back.`
        : row.payload.operation
          ? `[Approval] The user approved: "${row.title}". Make this exact tool call again now; the approval covers it once: ${JSON.stringify(row.payload.operation)}. If it says the teammate or connection changed since, read it again and tell the user instead of retrying with new values.`
          : `[Approval] The user approved: "${row.title}". Go ahead and do it now, then report back.`;
      await enqueueRun(this.ctx, {
        chatId: row.chatId,
        botId: row.botId,
        trigger: "approval",
        prompt:
          decision === "approved"
            ? approved
            : `[Approval] The user denied: "${row.title}". Don't do it. Briefly acknowledge, and continue with anything else that is left.`,
        parentRunId: row.runId,
      });
    }
    await publishApp(this.ctx, { type: "approvals" });
    return true;
  }

  /** Why an "always allow" pattern can't be saved for an approval, or null when it can. */
  async invalidRule(approvalId: string, pattern: string): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ kind: approvals.kind })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    return row ? invalidRulePattern(row.kind, pattern) : null;
  }

  async addRule(botId: string, kind: RuleKind, pattern: string): Promise<void> {
    const clean = kind === "file_change" ? "" : pattern.trim().replace(/\s+/g, " ").slice(0, 300);
    if (invalidRulePattern(kind, clean)) return;
    await this.ctx.db
      .insert(approvalRules)
      .values({ botId, kind, pattern: clean })
      .onConflictDoNothing();
    await publishApp(this.ctx, { type: "bots" });
  }

  async removeRule(ruleId: string): Promise<void> {
    await this.ctx.db.delete(approvalRules).where(eq(approvalRules.id, ruleId));
    await publishApp(this.ctx, { type: "bots" });
  }

  /**
   * Native approvals can't outlive their turn. Action and purchase approvals stay answerable after
   * the run ends.
   */
  async expireForRun(runId: string): Promise<void> {
    const expired = await this.ctx.db
      .update(approvals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.status, "pending"),
          notInArray(approvals.kind, ["action", "purchase", "email"]),
        ),
      )
      .returning();
    for (const row of expired) {
      this.waiters.delete(row.id);
      this.ctx.events.emit("approvalDecided", row.id);
      await appendRunEvent(this.ctx, row.runId, row.chatId, {
        type: "item",
        item: {
          id: row.itemId,
          kind: "approval",
          approvalId: row.id,
          approvalKind: row.kind,
          title: row.title,
          detail: row.detail,
          decision: "expired",
          status: "completed",
          startedAt: row.createdAt.toISOString(),
          completedAt: new Date().toISOString(),
        },
      });
    }
    if (expired.length) await publishApp(this.ctx, { type: "approvals" });
  }
}
