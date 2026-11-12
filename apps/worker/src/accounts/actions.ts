import {
  accountActions,
  accounts,
  approvals,
  bots,
  connections,
  type Queryable,
} from "@open-bot/db";
import {
  ACTION_APPROVAL_TTL_MS,
  accountTool,
  capabilityGranted,
  FINISHED_ACTION_STATUSES,
  integration,
  isAccountConnectionKind,
  rulesCover,
  type AccountActionStatus,
  type ToolItem,
} from "@open-bot/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { enqueueRun } from "../runs/queue";
import { appendRunEvent } from "../runs/events";
import { errorMessage } from "../logger";
import type { RunSession } from "../runs/session";
import type { ApprovalService } from "../services/approvals";
import type { SessionRegistry } from "../services/registry";
import {
  AccountToolError,
  ProviderError,
  type ActionOutcome,
  type ActionRow,
  type IntegrationAdapter,
  type Integrations,
  type PreparedAction,
  type ResolvedConnection,
  type TokenSource,
} from "@open-bot/integrations/adapters";
import type { AccountAccess } from "./access";
import { approvalFor } from "./effects";
import { expireApprovals } from "../services/approvals";

/** An action being run holds it this long; after that, the worker is taken to have stopped. */
const LEASE_MS = 5 * 60_000;
const SWEEP_MS = 30_000;
/** How long a teammate waits for your decision before it carries on without it. */
const APPROVAL_WAIT_MS = 10 * 60_000;
/** How long a teammate waits for a provider to finish something it does in the background. */
const PROVIDER_WAIT_MS = 60_000;
/** A provider's background work is given up on after this long. */
const PROVIDER_LIMIT_MS = 15 * 60_000;
const PROVIDER_RECHECK_MS = 15_000;

/** What the teammate hears about its action. */
export interface SubmitResult {
  status: AccountActionStatus;
  message: string;
}

const FINISHED = new Set<string>(FINISHED_ACTION_STATUSES);
const NEEDS_FOLLOW_UP = new Set<AccountActionStatus>([
  "denied",
  "failed",
  "unknown",
  "cancelled",
  "expired",
]);

function isFinished(row: Pick<ActionRow, "status">): boolean {
  return FINISHED.has(row.status);
}

/** What the teammate is told for an action in this state. */
export function actionMessage(row: ActionRow): string {
  const info = accountTool(row.tool);
  const provider = info ? integration(info.kind).label : "the service";
  switch (row.status) {
    case "done":
      return typeof row.result?.message === "string" ? row.result.message : "Done.";
    case "failed":
      return `It failed: ${row.error ?? "the provider refused it."}`;
    case "unknown":
      return `It may or may not have happened: ${row.error ?? "the answer was lost."} Don't do it again; tell the user, so they can check ${provider}.`;
    case "denied":
      return "The user didn't approve it, so it wasn't done. Don't do it, and don't ask again unless they bring it up.";
    case "cancelled":
      return `It was cancelled: ${row.error ?? "the connection changed."}`;
    case "expired":
      return "It wasn't approved within 7 days, so it won't happen.";
    case "waiting_on_provider":
      return `${provider} is still working on it, and it finishes by itself. Check the result later before relying on it.`;
    default:
      return "It's waiting for the user's approval, and happens by itself the moment they approve. Don't ask again or repeat it. End your turn and say it's ready for their approval.";
  }
}

/** The follow-up run's prompt when an action ends after its teammate stopped waiting. */
function followUp(row: ActionRow): string {
  switch (row.status) {
    case "denied":
      return `[Not approved] The user didn't approve: ${row.summary}. It wasn't done. Don't do it. Briefly acknowledge, and continue with anything else that's left.`;
    case "failed":
      return `[Couldn't do it] ${row.summary} failed after the user approved it: ${row.error}. Tell the user briefly, and fix it if you can.`;
    case "unknown":
      return `[Unclear] ${row.summary} may or may not have happened: ${row.error}. Don't do it again. Tell the user, so they can check.`;
    case "cancelled":
      return `[Cancelled] ${row.summary} didn't happen: ${row.error}. Tell the user only if it still matters.`;
    default:
      return `[Expired] The user didn't approve ${row.summary} within 7 days, so it won't happen. Mention it only if it still matters.`;
  }
}

/**
 * Every change to your accounts goes through here, whether it waited for you or not. It is
 * durable and at most once: an action is saved before anything happens, claimed atomically before
 * the provider is called, and checked again (connection, access, account, grant) whenever it is
 * about to run, including again after a recovery. An answer lost on the way back is looked up at
 * the provider, never blindly sent again. Integrations only supply how to run and look up their
 * own actions.
 */
/**
 * Actions still waiting on a connection that changed or went away never run, and their approval
 * cards close. Call `AccountActions.kick()` after the transaction, so their runs hear about it.
 */
export async function cancelConnectionActions(
  db: Queryable,
  connectionId: string,
  reason: string,
): Promise<number> {
  return cancelWaiting(db, eq(accountActions.connectionId, connectionId), reason);
}

/**
 * Cancel the account's pending and approved actions made under an earlier grant than
 * `grantRevision`, and expire their approvals. Returns how many were cancelled.
 */
export async function cancelEarlierGrantActions(
  db: Queryable,
  accountId: string,
  grantRevision: number,
  reason: string,
): Promise<number> {
  return cancelWaiting(
    db,
    and(eq(accountActions.accountId, accountId), lt(accountActions.grantRevision, grantRevision))!,
    reason,
  );
}

async function cancelWaiting(db: Queryable, which: SQL, reason: string): Promise<number> {
  const cancelled = await db
    .update(accountActions)
    .set({ status: "cancelled", error: reason, finishedAt: new Date() })
    .where(and(which, inArray(accountActions.status, ["pending", "approved"])))
    .returning({ approvalId: accountActions.approvalId });
  const approvalIds = cancelled
    .map((row) => row.approvalId)
    .filter((id): id is string => Boolean(id));
  await expireApprovals(db, approvalIds);
  return cancelled.length;
}

/** Your decision on an account action's approval moves the action on, if it still waits. */
export async function decideAccountAction(
  db: Queryable,
  approvalId: string,
  decision: "approved" | "denied",
): Promise<void> {
  await db
    .update(accountActions)
    .set({
      status: decision,
      decidedAt: new Date(),
      ...(decision === "denied" ? { finishedAt: new Date() } : {}),
    })
    .where(and(eq(accountActions.approvalId, approvalId), eq(accountActions.status, "pending")));
}

export class AccountActions {
  /** Teammates waiting on an action's outcome, by action id. */
  private readonly waiters = new Map<
    string,
    { runId: string; resolve: (row: ActionRow | null) => void }
  >();
  /** The sweep loop that is running, if any; kick() starts one, idle() waits for it. */
  private sweeping: Promise<void> | null = null;
  /** Set at shutdown: work that finishes afterwards starts no new sweep or poll. */
  private stopped = false;
  private again = false;
  private readonly polls = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly onDecided = (approvalId: string) => {
    void this.decided(approvalId).catch((error: unknown) =>
      this.ctx.log.error("could not act on an account decision", { error: errorMessage(error) }),
    );
  };
  private readonly onRunFinished = (run: { id: string }) => {
    for (const [id, waiter] of [...this.waiters])
      if (waiter.runId === run.id) {
        this.waiters.delete(id);
        waiter.resolve(null);
      }
  };

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionRegistry,
    private readonly approvals: ApprovalService,
    private readonly access: AccountAccess,
    private readonly integrations: Integrations,
  ) {}

  start(): void {
    this.ctx.events.on("approvalDecided", this.onDecided);
    this.ctx.events.on("runFinished", this.onRunFinished);
    this.kick();
    this.sweepTimer = setInterval(() => this.kick(), SWEEP_MS).unref();
  }

  /** Stops sweeping and polling, and stops listening. A sweep already running finishes; see idle(). */
  stop(): void {
    this.stopped = true;
    this.ctx.events.off("approvalDecided", this.onDecided);
    this.ctx.events.off("runFinished", this.onRunFinished);
    clearInterval(this.sweepTimer);
    for (const timer of this.polls.values()) clearTimeout(timer);
    this.polls.clear();
  }

  /**
   * A teammate's action: done now when nothing needs asking, otherwise saved with its approval.
   * Either way the teammate waits a while for the outcome, so it can carry on with it.
   */
  async submit(
    session: RunSession,
    resolved: ResolvedConnection,
    actionId: string,
    prepared: PreparedAction,
    itemId: string,
  ): Promise<SubmitResult> {
    const rules = await this.approvals.rulesFor(session.bot.id);
    const kind = approvalFor({
      effect: prepared.effect,
      autonomy: session.bot.autonomy,
      askBeforeActing: resolved.connection.askBeforeActing,
      readOutsideData: session.run.readOutsideData,
      coveredByRule: rulesCover(rules, "account_write", prepared.tool),
    });
    const values = {
      id: actionId,
      connectionId: resolved.connection.id,
      accountId: resolved.account.id,
      grantRevision: resolved.account.grantRevision,
      connectionRevision: resolved.connection.revision,
      botId: session.bot.id,
      runId: session.run.id,
      chatId: session.chat.id,
      itemId,
      tool: prepared.tool,
      effect: prepared.effect,
      request: prepared.request,
      summary: prepared.summary,
      labels: prepared.labels,
      preview: prepared.preview,
      expiresAt: new Date(Date.now() + ACTION_APPROVAL_TTL_MS),
    };
    const outcome = this.waitFor(actionId, session.run.id);
    if (!kind) {
      await this.ctx.db
        .insert(accountActions)
        .values({ ...values, status: "approved", decidedAt: new Date() });
      session.putItem(this.item(values, "executing", session.now()));
      const row = await this.execute(actionId);
      if (row && isFinished(row)) {
        this.release(actionId);
        return this.deliver(session, row);
      }
      // The provider still working on it, or another worker claimed it: wait a little for the end.
      const finished = await Promise.race([outcome.promise, timeout(PROVIDER_WAIT_MS)]);
      this.release(actionId);
      return finished ? this.deliver(session, finished) : this.current(actionId);
    }
    await this.approvals.requestAccountAction(
      session,
      {
        kind,
        title: prepared.summary,
        detail: prepared.detail,
        itemId: `${itemId}-approval`,
        subject: prepared.tool,
        preview: prepared.preview,
        actionId,
      },
      async (tx, approvalId) => {
        await tx.insert(accountActions).values({ ...values, approvalId });
      },
    );
    session.putItem(this.item(values, "pending", session.now()));
    const finished = await session.whileWaiting("approval", () =>
      Promise.race([outcome.promise, timeout(APPROVAL_WAIT_MS)]),
    );
    this.release(actionId);
    if (finished) return this.deliver(session, finished);
    // Still waiting: whatever happens next is reported in this chat by itself.
    this.kick();
    return this.current(actionId);
  }

  private waitFor(actionId: string, runId: string): { promise: Promise<ActionRow | null> } {
    let resolve!: (row: ActionRow | null) => void;
    const promise = new Promise<ActionRow | null>((done) => (resolve = done));
    this.waiters.set(actionId, { runId, resolve });
    return { promise };
  }

  private release(actionId: string): void {
    this.waiters.delete(actionId);
  }

  private async current(actionId: string): Promise<SubmitResult> {
    const [row] = await this.ctx.db
      .select()
      .from(accountActions)
      .where(eq(accountActions.id, actionId));
    return row
      ? { status: row.status, message: actionMessage(row) }
      : { status: "failed", message: "The action is gone." };
  }

  /** The outcome, told to the teammate that's waiting for it, and shown in its run. */
  private async deliver(session: RunSession, row: ActionRow): Promise<SubmitResult> {
    const [claimed] = await this.ctx.db
      .update(accountActions)
      .set({ reportedAt: new Date() })
      .where(and(eq(accountActions.id, row.id), isNull(accountActions.reportedAt)))
      .returning();
    if (claimed)
      session.putItem(this.item(claimed, claimed.status, claimed.createdAt.toISOString()));
    return { status: row.status, message: actionMessage(claimed ?? row) };
  }

  /** The action's tool item in the timeline, as it stands. */
  private item(
    row: Pick<ActionRow, "itemId" | "tool" | "summary" | "labels" | "preview"> &
      Partial<Pick<ActionRow, "error" | "result">>,
    status: AccountActionStatus,
    startedAt: string,
  ): ToolItem {
    const finished = FINISHED.has(status);
    const label =
      status === "done"
        ? row.labels.done
        : status === "pending"
          ? row.labels.waiting
          : status === "denied"
            ? `Not approved: ${row.summary}`
            : status === "unknown"
              ? `${row.summary}: may or may not have happened`
              : status === "cancelled" || status === "expired"
                ? `Didn't happen: ${row.summary}`
                : finished
                  ? row.labels.failed
                  : row.summary;
    return {
      id: row.itemId,
      kind: "tool",
      name: row.tool,
      label: label.slice(0, 160),
      args: row.preview ?? { summary: row.summary },
      status: !finished ? "running" : status === "done" ? "completed" : "failed",
      startedAt,
      ...(finished ? { completedAt: new Date().toISOString() } : {}),
      ...(status === "done" && typeof row.result?.message === "string"
        ? { result: row.result.message }
        : {}),
      ...(finished && status !== "done" ? { error: row.error ?? label } : {}),
    };
  }

  /** You decided: run the action, or let its teammate know you didn't approve it. */
  private async decided(approvalId: string): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(accountActions)
      .where(eq(accountActions.approvalId, approvalId));
    if (!row) return;
    if (row.status === "approved") {
      await this.execute(row.id);
      return;
    }
    if (isFinished(row)) this.settled(row);
  }

  /** Claim an approved action and run it. Returns where it ended up. */
  private async execute(actionId: string): Promise<ActionRow | null> {
    const [claimed] = await this.ctx.db
      .update(accountActions)
      .set({
        status: "executing",
        attempt: sql`${accountActions.attempt} + 1`,
        nextCheckAt: new Date(Date.now() + LEASE_MS),
      })
      .where(and(eq(accountActions.id, actionId), eq(accountActions.status, "approved")))
      .returning();
    if (!claimed) {
      const [row] = await this.ctx.db
        .select()
        .from(accountActions)
        .where(eq(accountActions.id, actionId));
      return row ?? null;
    }
    return this.perform(claimed, "execute");
  }

  /**
   * The connection and account the action runs with, if it still may. Looking one up (`strict`
   * false) only needs the same account, still signed in. Running it (`strict`) needs everything it
   * was approved under to still hold: the connection on and unchanged, the teammate still allowed,
   * the capability still allowed and granted, and the grant itself not narrowed or remade.
   */
  private async check(
    action: ActionRow,
    strict: boolean,
  ): Promise<{ resolved: ResolvedConnection } | { reason: string }> {
    if (!action.connectionId || !action.accountId)
      return { reason: "The user removed the connection." };
    const [row] = await this.ctx.db
      .select({ connection: connections, account: accounts })
      .from(connections)
      .innerJoin(accounts, eq(accounts.id, connections.accountId))
      .where(eq(connections.id, action.connectionId));
    if (!row || !isAccountConnectionKind(row.connection.kind))
      return { reason: "The user removed the connection." };
    const kind = row.connection.kind;
    const label = integration(kind).label;
    if (row.account.id !== action.accountId)
      return { reason: `${label} uses a different account now.` };
    if (row.account.status !== "connected") return { reason: `${label} needs reconnecting.` };
    if (strict) {
      if (!row.connection.enabled) return { reason: `The user turned ${label} off.` };
      if (row.connection.revision !== action.connectionRevision)
        return { reason: `The user changed ${label}'s settings since it was asked for.` };
      if (row.account.grantRevision !== action.grantRevision)
        return { reason: `${label}'s sign-in changed since it was asked for.` };
      if (row.connection.botIds && (!action.botId || !row.connection.botIds.includes(action.botId)))
        return { reason: `The teammate no longer has ${label}.` };
      const capability = accountTool(action.tool)?.capability;
      if (
        !capability ||
        !row.connection.capabilities.includes(capability) ||
        !capabilityGranted(kind, capability, row.account.scopes)
      )
        return { reason: `${label} no longer allows this.` };
    }
    return { resolved: { kind, connection: row.connection, account: row.account } };
  }

  /** Run, look up, or poll an action at its provider, and record what happened. */
  private async perform(
    action: ActionRow,
    how: "execute" | "reconcile" | "poll",
  ): Promise<ActionRow> {
    const checked = await this.check(action, how === "execute");
    if ("reason" in checked) {
      return this.finish(
        action,
        how === "execute"
          ? { status: "cancelled", error: checked.reason }
          : { status: "unknown", error: `${checked.reason} So it couldn't be checked.` },
      );
    }
    const { resolved } = checked;
    const adapter = this.integrations.get(resolved.kind);
    const runner = adapter.runner;
    const tokens = this.access.tokens(resolved);
    let outcome: ActionOutcome | { status: "cancelled"; error: string };
    try {
      if (how === "poll" && runner.poll) outcome = await runner.poll(action, tokens, resolved);
      else if (how === "reconcile") {
        const found = await runner.reconcile(action, tokens, resolved);
        outcome =
          found === "not_done"
            ? await this.runAgain(action)
            : (found ?? {
                status: "unknown",
                error: "The worker stopped while doing this, so it can't tell whether it happened.",
              });
      } else outcome = await runner.execute(action, tokens, resolved);
    } catch (error) {
      outcome = await this.failure(action, error, how, adapter, tokens, resolved);
    }
    return this.finish(action, outcome);
  }

  /**
   * Run an action that certainly didn't happen yet, after a recovery found so. The lookup only
   * needed the account; running needs everything it was approved under, checked again now, since
   * you may have changed or removed access while it was stuck.
   */
  private async runAgain(
    action: ActionRow,
  ): Promise<ActionOutcome | { status: "cancelled"; error: string }> {
    const checked = await this.check(action, true);
    if ("reason" in checked) return { status: "cancelled", error: checked.reason };
    const { resolved } = checked;
    return this.integrations
      .get(resolved.kind)
      .runner.execute(action, this.access.tokens(resolved), resolved);
  }

  /** What a failed call means: refused, or perhaps done. Looks before saying "perhaps". */
  private async failure(
    action: ActionRow,
    error: unknown,
    how: "execute" | "reconcile" | "poll",
    adapter: IntegrationAdapter,
    tokens: TokenSource,
    resolved: ResolvedConnection,
  ): Promise<ActionOutcome | { status: "cancelled"; error: string }> {
    const problem = (failure: ProviderError) => adapter.problem(failure);
    if (how === "poll")
      return {
        status: "waiting",
        providerRef: action.providerRef ?? {},
        checkAfterMs: PROVIDER_RECHECK_MS,
      };
    if (error instanceof AccountToolError) return { status: "failed", error: error.message };
    if (error instanceof ProviderError && !error.ambiguous)
      return { status: "failed", error: problem(error) };
    if (!(error instanceof ProviderError))
      this.ctx.log.error("an account action failed unexpectedly", {
        tool: action.tool,
        error: errorMessage(error),
      });
    const reason = error instanceof ProviderError ? problem(error) : errorMessage(error);
    try {
      const found = await adapter.runner.reconcile(action, tokens, resolved);
      if (found && found !== "not_done") return found;
      // It certainly didn't happen, and running it again can't make it happen twice.
      if (found === "not_done") return await this.runAgain(action);
    } catch {
      // Couldn't tell; say so below.
    }
    return { status: "unknown", error: reason };
  }

  /** Record an outcome, and tell whoever waits for it. */
  private async finish(
    action: ActionRow,
    outcome: ActionOutcome | { status: "cancelled"; error: string },
  ): Promise<ActionRow> {
    if (outcome.status === "waiting") {
      const since =
        typeof action.providerRef?.since === "string"
          ? Date.parse(action.providerRef.since)
          : Date.now();
      if (Date.now() - since > PROVIDER_LIMIT_MS)
        return this.finish(action, {
          status: "unknown",
          error: "The provider didn't finish it within 15 minutes.",
          providerRef: outcome.providerRef,
        });
      const [row] = await this.ctx.db
        .update(accountActions)
        .set({
          status: "waiting_on_provider",
          providerRef: { ...outcome.providerRef, since: new Date(since).toISOString() },
          nextCheckAt: new Date(Date.now() + outcome.checkAfterMs),
        })
        .where(eq(accountActions.id, action.id))
        .returning();
      this.schedulePoll(action.id, outcome.checkAfterMs);
      return row!;
    }
    const [row] = await this.ctx.db
      .update(accountActions)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        nextCheckAt: null,
        ...(outcome.status === "done"
          ? { result: { ...outcome.result, message: outcome.message }, error: null }
          : { error: outcome.error }),
        ...("providerRef" in outcome && outcome.providerRef
          ? { providerRef: { ...action.providerRef, ...outcome.providerRef } }
          : {}),
      })
      .where(eq(accountActions.id, action.id))
      .returning();
    if (outcome.status === "done") {
      await this.integrations
        .forTool(row!.tool)
        ?.runner.done?.(row!, outcome)
        .catch((error: unknown) =>
          this.ctx.log.warn("could not record what an action made", { error: errorMessage(error) }),
        );
    }
    this.settled(row!);
    return row!;
  }

  /** A finished action: wake its teammate if it waits, or report it from the sweep. */
  private settled(row: ActionRow): void {
    const waiter = this.waiters.get(row.id);
    if (waiter) {
      this.waiters.delete(row.id);
      waiter.resolve(row);
      return;
    }
    this.kick();
  }

  private schedulePoll(actionId: string, delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.polls.get(actionId));
    this.polls.set(
      actionId,
      setTimeout(() => {
        this.polls.delete(actionId);
        void this.poll(actionId).catch((error: unknown) =>
          this.ctx.log.warn("could not check on an action", { error: errorMessage(error) }),
        );
      }, delayMs).unref(),
    );
  }

  private async poll(actionId: string): Promise<void> {
    const [claimed] = await this.ctx.db
      .update(accountActions)
      .set({ nextCheckAt: new Date(Date.now() + LEASE_MS) })
      .where(
        and(
          eq(accountActions.id, actionId),
          eq(accountActions.status, "waiting_on_provider"),
          lte(accountActions.nextCheckAt, new Date()),
        ),
      )
      .returning();
    if (claimed) await this.perform(claimed, "poll");
  }

  /** Look at everything that needs doing, now. Runs one sweep at a time. */
  kick(): void {
    if (this.stopped) return;
    if (this.sweeping) {
      this.again = true;
      return;
    }
    this.sweeping = (async () => {
      try {
        do {
          this.again = false;
          await this.sweep();
        } while (this.again && !this.stopped);
      } catch (error) {
        this.ctx.log.error("account actions sweep failed", { error: errorMessage(error) });
      } finally {
        this.sweeping = null;
      }
    })();
  }

  /**
   * Resolves once no sweep is running, including the ones a finished action kicks. Shutdown waits
   * for it before closing the database pool, and tests wait for it before they look.
   */
  async idle(): Promise<void> {
    while (this.sweeping) await this.sweeping;
  }

  private async sweep(): Promise<void> {
    const now = new Date();
    // Not approved in time.
    await this.ctx.db
      .update(accountActions)
      .set({ status: "expired", finishedAt: now, error: "It wasn't approved within 7 days." })
      .where(and(eq(accountActions.status, "pending"), lte(accountActions.expiresAt, now)));

    // Approved, but not run yet (a decision just before a restart, or a busy moment).
    const approved = await this.ctx.db
      .select({ id: accountActions.id })
      .from(accountActions)
      .where(eq(accountActions.status, "approved"))
      .orderBy(asc(accountActions.decidedAt))
      .limit(20);
    for (const { id } of approved) await this.execute(id);

    // Running when the worker stopped: find out whether it happened.
    const stale = await this.ctx.db
      .update(accountActions)
      .set({ nextCheckAt: new Date(now.getTime() + LEASE_MS) })
      .where(and(eq(accountActions.status, "executing"), lte(accountActions.nextCheckAt, now)))
      .returning();
    for (const row of stale) await this.perform(row, "reconcile");

    // A provider's background work that's due a look.
    const due = await this.ctx.db
      .select({ id: accountActions.id })
      .from(accountActions)
      .where(
        and(eq(accountActions.status, "waiting_on_provider"), lte(accountActions.nextCheckAt, now)),
      )
      .limit(20);
    for (const { id } of due) await this.poll(id);

    // Outcomes nobody heard about yet.
    const unreported = await this.ctx.db
      .select()
      .from(accountActions)
      .where(and(isNull(accountActions.reportedAt), isNotNull(accountActions.finishedAt)))
      .orderBy(asc(accountActions.finishedAt))
      .limit(50);
    for (const row of unreported) {
      if (this.waiters.has(row.id)) continue;
      await this.report(row);
    }
  }

  /**
   * Tell the run that asked for an action how it ended: its timeline item, its approval if that
   * was still open, and a follow-up run when the teammate should know (not for done, which the
   * timeline shows).
   */
  private async report(row: ActionRow): Promise<void> {
    const [claimed] = await this.ctx.db
      .update(accountActions)
      .set({ reportedAt: new Date() })
      .where(and(eq(accountActions.id, row.id), isNull(accountActions.reportedAt)))
      .returning();
    if (!claimed || !claimed.runId || !claimed.chatId) return;
    const item = this.item(claimed, claimed.status, claimed.createdAt.toISOString());
    const session = this.sessions.get(claimed.runId);
    if (session) session.putItem(item);
    else await appendRunEvent(this.ctx, claimed.runId, claimed.chatId, { type: "item", item });

    // Cancelled or expired while it waited for you: its approval closes too.
    if (claimed.approvalId && (claimed.status === "cancelled" || claimed.status === "expired")) {
      await expireApprovals(this.ctx.db, [claimed.approvalId]);
      // Closed here, or already when you changed the connection.
      const [approval] = await this.ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, claimed.approvalId));
      if (approval?.status === "expired") {
        await appendRunEvent(this.ctx, approval.runId, approval.chatId, {
          type: "item",
          item: {
            id: approval.itemId,
            kind: "approval",
            approvalId: approval.id,
            approvalKind: approval.kind,
            title: approval.title,
            detail: approval.detail,
            decision: "expired",
            status: "completed",
            startedAt: approval.createdAt.toISOString(),
            completedAt: new Date().toISOString(),
          },
        });
        this.ctx.events.emit("approvalDecided", approval.id);
        await publishApp(this.ctx, { type: "approvals" });
      }
    }

    if (!NEEDS_FOLLOW_UP.has(claimed.status) || !claimed.botId) return;
    const [bot] = await this.ctx.db
      .select({ archivedAt: bots.archivedAt })
      .from(bots)
      .where(eq(bots.id, claimed.botId));
    if (!bot || bot.archivedAt) return;
    await enqueueRun(this.ctx, {
      chatId: claimed.chatId,
      botId: claimed.botId,
      trigger: "approval",
      prompt: followUp(claimed),
      parentRunId: claimed.runId,
    });
  }
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms).unref());
}
