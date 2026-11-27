import { randomBytes, randomUUID } from "node:crypto";
import type { TriggerCheck } from "@open-bot/api/worker";
import {
  accountConnections,
  teammates,
  connections,
  runs,
  triggers,
  type Queryable,
  type Tx,
} from "@open-bot/db";
import {
  describeGmailQuery,
  describeInterval,
  describeLead,
  isAccountTrigger,
  describeWatchChange,
  PAGE_TEXT_NOTE,
  summarizeWatchChange,
  watchChange,
  WEBHOOK_PAYLOAD_NOTE,
  type TriggerKind,
} from "@open-bot/domain";
import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { announceRun, insertRun } from "../../runs/queue";
import { errorMessage } from "../../logger";
import { mainChat } from "../chat";
import { fetchPage } from "./page-fetch";
import {
  checkLead,
  checkTriggerTitle,
  checkWatchInterval,
  TriggerError,
  type TriggerInput,
  validateTrigger,
} from "./trigger-input";

export type Trigger = typeof triggers.$inferSelect;

const TICK_MS = 30_000;
/** Checks running at once, so many watches due together don't flood the network. */
const CHECK_CONCURRENCY = 4;
/** A webhook can start at most this many runs an hour, so a noisy sender can't run up a bill. */
export const WEBHOOK_RUNS_PER_HOUR = 30;
/** The same limit for Gmail and Calendar triggers, so a flood of mail can't either. */
export const ACCOUNT_TRIGGER_RUNS_PER_HOUR = 30;
const MAX_PAYLOAD_CHARS = 20_000;

export type CheckResult = TriggerCheck;

/** What `patch` may change: a name, and a watch's interval or a Calendar trigger's lead time. */
export interface TriggerPatch {
  title?: string;
  intervalMinutes?: number;
  leadMinutes?: number;
}

/**
 * A run's prompt, made in the transaction that saves the run: it records what the run is about
 * and returns the prompt, or null to start nothing. `runId` is the run it will save.
 */
export type FirePrompt = (tx: Tx, runId: string) => Promise<string | null>;

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function payloadText(body: string, contentType: string): string {
  let text = body;
  if (/json/i.test(contentType)) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Not valid JSON after all; pass it on as it came.
    }
  }
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n… (${text.length - MAX_PAYLOAD_CHARS} more characters)`
    : text;
}

/**
 * Watches and webhooks: wake a teammate when a page changes or a service calls it. Gmail and
 * Calendar triggers are saved here too, and checked by AccountTriggers.
 */
export class TriggerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  /** Checks Gmail and Calendar triggers now, after one changed. */
  private accountKick: (() => void) | null = null;

  constructor(private readonly ctx: Context) {}

  /** AccountTriggers registers here, so a new or changed trigger is checked right away. */
  onAccountTriggerChange(kick: () => void): void {
    this.accountKick = kick;
  }

  private kickFor(kind: TriggerKind): void {
    if (isAccountTrigger(kind)) this.accountKick?.();
    else this.kick();
  }

  /** The address services call to fire a webhook. */
  webhookUrl(token: string): string {
    return `${this.ctx.env.APP_URL.replace(/\/+$/, "")}/api/hooks/${token}`;
  }

  async create(
    input: TriggerInput,
    by: { kind: "user" } | { kind: "teammate"; runId: string },
  ): Promise<Trigger> {
    const fields = await validateTrigger(this.ctx.db, input);
    const [row] = await this.ctx.db
      .insert(triggers)
      .values({
        teammateId: input.teammateId,
        kind: input.kind,
        ...fields,
        token: input.kind === "webhook" ? newToken() : null,
        // A new watch checks right away, to learn what the page (or the mailbox) looks like now.
        nextCheckAt: input.kind === "webhook" ? null : new Date(),
        createdBy: by.kind,
        createdByRunId: by.kind === "teammate" ? by.runId : null,
      })
      .returning();
    await publishApp(this.ctx, { type: "triggers" });
    this.kickFor(input.kind);
    return row!;
  }

  async update(id: string, input: TriggerInput): Promise<Trigger> {
    const [existing] = await this.ctx.db.select().from(triggers).where(eq(triggers.id, id));
    if (!existing) throw new TriggerError("That automation no longer exists.");
    if (existing.kind !== input.kind)
      throw new TriggerError("An automation can't change its kind.");
    const fields = await validateTrigger(this.ctx.db, input);
    // A watch on a new page, or looking for new text, starts over from a fresh look at the page.
    const restart =
      existing.kind === "watch" &&
      (existing.url !== fields.url || existing.lookFor !== fields.lookFor);
    // A Gmail trigger on another account starts from that mailbox as it is now; a Calendar one
    // looks again with its new timing.
    const recheck =
      isAccountTrigger(existing.kind) &&
      (existing.connectionId !== fields.connectionId ||
        existing.leadMinutes !== fields.leadMinutes ||
        existing.query !== fields.query);
    const newMailbox = existing.kind === "gmail" && existing.connectionId !== fields.connectionId;
    const [row] = await this.ctx.db
      .update(triggers)
      .set({
        teammateId: input.teammateId,
        ...fields,
        ...(restart ? { snapshot: null, lastError: null, nextCheckAt: new Date() } : {}),
        ...(recheck ? { lastError: null, nextCheckAt: new Date() } : {}),
        ...(newMailbox ? { cursor: null } : {}),
        ...(existing.kind === "watch" &&
        !restart &&
        existing.intervalMinutes !== fields.intervalMinutes &&
        existing.lastCheckedAt
          ? {
              nextCheckAt: new Date(
                existing.lastCheckedAt.getTime() + fields.intervalMinutes! * 60_000,
              ),
            }
          : {}),
      })
      .where(eq(triggers.id, id))
      .returning();
    await publishApp(this.ctx, { type: "triggers" });
    this.kickFor(existing.kind);
    return row!;
  }

  /**
   * Change only the fields given, as the phone edits a name or a timing: the page, filters,
   * account and instructions stay as they are, so an edit made elsewhere meanwhile isn't undone,
   * and a trigger whose account was turned off can still be renamed. The row is locked while it's
   * read and written. A new interval counts from the last check, and a new lead time looks at
   * the calendar again, as `update` does.
   */
  async patch(id: string, changes: TriggerPatch): Promise<Trigger> {
    const title = changes.title === undefined ? undefined : checkTriggerTitle(changes.title);
    const row = await this.ctx.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(triggers).where(eq(triggers.id, id)).for("update");
      if (!existing) throw new TriggerError("That automation was deleted.", 404);
      if (changes.intervalMinutes !== undefined && existing.kind !== "watch")
        throw new TriggerError("Only a page watch checks on an interval.");
      if (changes.leadMinutes !== undefined && existing.kind !== "calendar")
        throw new TriggerError("Only a Calendar trigger wakes before an event.");
      const intervalMinutes =
        changes.intervalMinutes === undefined
          ? undefined
          : checkWatchInterval(changes.intervalMinutes);
      const leadMinutes =
        changes.leadMinutes === undefined ? undefined : checkLead(changes.leadMinutes);
      const newInterval =
        intervalMinutes !== undefined && intervalMinutes !== existing.intervalMinutes;
      const newLead = leadMinutes !== undefined && leadMinutes !== existing.leadMinutes;
      const [updated] = await tx
        .update(triggers)
        .set({
          ...(title !== undefined ? { title } : {}),
          ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
          ...(newInterval && existing.lastCheckedAt
            ? { nextCheckAt: new Date(existing.lastCheckedAt.getTime() + intervalMinutes * 60_000) }
            : {}),
          ...(leadMinutes !== undefined ? { leadMinutes } : {}),
          ...(newLead ? { lastError: null, nextCheckAt: new Date() } : {}),
        })
        .where(eq(triggers.id, id))
        .returning();
      return updated!;
    });
    await publishApp(this.ctx, { type: "triggers" });
    this.kickFor(row.kind);
    return row;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const [existing] = await this.ctx.db
      .select({ kind: triggers.kind })
      .from(triggers)
      .where(eq(triggers.id, id));
    if (!existing) throw new TriggerError("That automation no longer exists.");
    // Turning a trigger back on checks right away. Mail that came while it was paused doesn't
    // wake the teammate: a resumed Gmail trigger starts from the mailbox as it is now.
    const [row] = await this.ctx.db
      .update(triggers)
      .set({
        enabled,
        ...(enabled && existing.kind !== "webhook"
          ? { nextCheckAt: new Date(), lastError: null }
          : {}),
        ...(enabled && existing.kind === "gmail" ? { cursor: null } : {}),
      })
      .where(eq(triggers.id, id))
      .returning({ kind: triggers.kind });
    if (!row) throw new TriggerError("That automation no longer exists.");
    await publishApp(this.ctx, { type: "triggers" });
    this.kickFor(row.kind);
  }

  async remove(id: string): Promise<Trigger | null> {
    const [row] = await this.ctx.db.delete(triggers).where(eq(triggers.id, id)).returning();
    if (row) await publishApp(this.ctx, { type: "triggers" });
    return row ?? null;
  }

  /** A new webhook URL; the old one stops working. */
  async rotateToken(id: string): Promise<string> {
    const token = newToken();
    const [row] = await this.ctx.db
      .update(triggers)
      .set({ token })
      .where(and(eq(triggers.id, id), eq(triggers.kind, "webhook")))
      .returning({ id: triggers.id });
    if (!row) throw new TriggerError("That webhook no longer exists.");
    await publishApp(this.ctx, { type: "triggers" });
    return token;
  }

  async kindOf(id: string): Promise<TriggerKind | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.ctx.db
      .select({ kind: triggers.kind })
      .from(triggers)
      .where(eq(triggers.id, id));
    return row?.kind ?? null;
  }

  async forTeammate(teammateId: string): Promise<Trigger[]> {
    return this.ctx.db.select().from(triggers).where(eq(triggers.teammateId, teammateId));
  }

  /** The teammate's own watches, webhooks and Gmail and Calendar triggers, as it reads them. */
  async describeForTeammate(teammateId: string): Promise<string | null> {
    const rows = await this.ctx.db
      .select({ trigger: triggers, account: accountConnections.display })
      .from(triggers)
      .leftJoin(connections, eq(connections.id, triggers.connectionId))
      .leftJoin(accountConnections, eq(accountConnections.id, connections.accountId))
      .where(eq(triggers.teammateId, teammateId));
    if (rows.length === 0) return null;
    return rows
      .map(({ trigger: row, account }) => {
        const state = row.enabled ? "on" : "paused";
        const problem = row.lastError ? ` (last check failed: ${row.lastError})` : "";
        if (row.kind === "webhook")
          return `- ${row.id}: webhook "${row.title}", ${state}, URL ${this.webhookUrl(row.token!)}`;
        if (row.kind === "gmail")
          return `- ${row.id}: Gmail trigger "${row.title}" on ${account ?? "Gmail"}, for ${describeGmailQuery(row.query)}, ${state}${problem}`;
        if (row.kind === "calendar")
          return `- ${row.id}: Calendar trigger "${row.title}" on ${account ?? "Google Calendar"}, ${describeLead(row.leadMinutes ?? 30).toLowerCase()} ${row.query === "guests" ? "events with other people" : "every event"}, ${state}${problem}`;
        const look = row.lookFor ? `, waiting for "${row.lookFor}"` : "";
        return `- ${row.id}: watch "${row.title}" on ${row.url}, ${describeInterval(row.intervalMinutes ?? 60).toLowerCase()}${look}, ${state}`;
      })
      .join("\n");
  }

  /* -------------------------------------------------------------- Webhooks */

  /** A service called a webhook: start its teammate with what it sent. */
  async fireWebhook(
    token: string,
    request: { method: string; contentType: string; body: string; query: string },
  ): Promise<{ runId: string } | { error: string; status: number }> {
    const [row] = await this.ctx.db.select().from(triggers).where(eq(triggers.token, token));
    if (!row || row.kind !== "webhook") return { error: "Unknown webhook", status: 404 };
    if (!row.enabled) return { error: "This webhook is paused", status: 409 };
    const [teammate] = await this.ctx.db
      .select()
      .from(teammates)
      .where(eq(teammates.id, row.teammateId));
    if (!teammate || teammate.archivedAt)
      return { error: "This webhook's teammate is archived", status: 409 };
    const [recent] = await this.ctx.db
      .select({ value: count() })
      .from(runs)
      .where(
        and(eq(runs.triggerId, row.id), gte(runs.createdAt, new Date(Date.now() - 3_600_000))),
      );
    if ((recent?.value ?? 0) >= WEBHOOK_RUNS_PER_HOUR)
      return {
        error: `This webhook already started ${WEBHOOK_RUNS_PER_HOUR} runs in the last hour. Try again later.`,
        status: 429,
      };

    const received = [
      `${request.method} with ${request.contentType || "no content type"}`,
      request.query ? `Query: ${request.query}` : null,
      request.body
        ? `Body:\n\`\`\`\n${payloadText(request.body, request.contentType)}\n\`\`\``
        : "No body.",
    ]
      .filter(Boolean)
      .join("\n");
    const runId = await this.fire(
      row,
      `[Webhook: "${row.title}"]\n\n${row.prompt}\n\n${WEBHOOK_PAYLOAD_NOTE}\n${received}`,
    );
    if (!runId) return { error: "This webhook's teammate is archived", status: 409 };
    return { runId };
  }

  /* -------------------------------------------------------------- Watches */

  start(): void {
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Check due watches now. A kick during a check runs another pass right after it. */
  kick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.tick()
      .catch((error: unknown) =>
        this.ctx.log.error("watch tick failed", { error: errorMessage(error) }),
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
    // Claim due watches by moving their next check forward, so a slow check never runs twice.
    const due = await this.ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(triggers)
        .where(
          and(
            eq(triggers.kind, "watch"),
            eq(triggers.enabled, true),
            lte(triggers.nextCheckAt, new Date()),
          ),
        )
        .for("update", { skipLocked: true });
      for (const row of rows) {
        await tx
          .update(triggers)
          .set({ nextCheckAt: new Date(Date.now() + (row.intervalMinutes ?? 60) * 60_000) })
          .where(eq(triggers.id, row.id));
      }
      return rows;
    });
    const queue = [...due];
    await Promise.all(
      Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) await this.check(row);
      }),
    );
  }

  /** Check a watch now, without changing when it checks next. */
  async checkNow(id: string): Promise<CheckResult> {
    const [row] = await this.ctx.db.select().from(triggers).where(eq(triggers.id, id));
    if (!row || row.kind !== "watch") throw new TriggerError("That watch no longer exists.");
    return this.check(row);
  }

  private async check(row: Trigger): Promise<CheckResult> {
    let text: string;
    try {
      text = await fetchPage(row.url!, this.ctx.env.WATCH_ALLOW_PRIVATE_URLS);
    } catch (error) {
      const message = errorMessage(error);
      await this.ctx.db
        .update(triggers)
        .set({ lastCheckedAt: new Date(), lastError: message })
        .where(eq(triggers.id, row.id));
      await publishApp(this.ctx, { type: "triggers" });
      return { ok: false, changed: false, summary: message };
    }
    const change = watchChange(row.snapshot, text, row.lookFor);
    const now = new Date();
    // Saves what the page looks like now, only if no other check (Check now, or the timer) saved
    // a newer look since this one read the snapshot: that check reports the change, once.
    const see = async (db: Queryable) => {
      const saved = await db
        .update(triggers)
        .set({ snapshot: text, lastCheckedAt: now, lastError: null })
        .where(
          and(
            eq(triggers.id, row.id),
            sql`${triggers.snapshot} is not distinct from ${row.snapshot}`,
          ),
        )
        .returning({ id: triggers.id });
      return saved.length > 0;
    };
    const overtaken = { ok: true, changed: false, summary: "Another check saw this first" };
    if (change) {
      const summary = summarizeWatchChange(change);
      let raced = false;
      try {
        // The new snapshot is saved with the run, so a run that can't start leaves the change
        // for the next check to find again.
        const runId = await this.fire(row, async (tx) => {
          if (!(await see(tx))) {
            raced = true;
            return null;
          }
          return `[Watch: "${row.title}"]\n\n${row.prompt}\n\nThe page ${row.url} changed since the last check (${summary}). ${PAGE_TEXT_NOTE}\n\n${describeWatchChange(change)}`;
        });
        // Its teammate is archived: nobody to wake, so the page as it is now is what's next.
        if (!runId && !raced) await see(this.ctx.db);
      } catch (error) {
        const message = `The page changed, but its teammate couldn't start: ${errorMessage(error)}`;
        await this.ctx.db
          .update(triggers)
          .set({ lastCheckedAt: now, lastError: message })
          .where(eq(triggers.id, row.id));
        await publishApp(this.ctx, { type: "triggers" });
        return { ok: false, changed: true, summary: message };
      }
      await publishApp(this.ctx, { type: "triggers" });
      return raced ? overtaken : { ok: true, changed: true, summary };
    }
    const saw = await see(this.ctx.db);
    await publishApp(this.ctx, { type: "triggers" });
    if (!saw) return overtaken;
    return {
      ok: true,
      changed: false,
      summary: row.snapshot === null ? "Saw the page for the first time" : "No change",
    };
  }

  /* -------------------------------------------------------------- Firing */

  /**
   * Start the trigger's teammate in its main chat. `readOutsideData` starts the run as one
   * that read your accounts, so it asks before sending anything.
   *
   * The prompt can be a `FirePrompt`, which runs in the run's transaction before the run is saved:
   * it records what the run is about (a page's snapshot, the mail it claimed) and gives the prompt,
   * or null to start nothing. Both commit together, so a run that can't be saved leaves what caused
   * it for the next check to find again. Returns the run, or null when nothing started.
   */
  async fire(
    row: Trigger,
    prompt: string | FirePrompt,
    options: { readOutsideData?: boolean } = {},
  ): Promise<string | null> {
    const [teammate] = await this.ctx.db
      .select({ archivedAt: teammates.archivedAt })
      .from(teammates)
      .where(eq(teammates.id, row.teammateId));
    if (!teammate || teammate.archivedAt) return null;
    const chatId = await mainChat(this.ctx, row.teammateId);
    const runId = await this.ctx.db.transaction(async (tx) => {
      const id = randomUUID();
      const text = typeof prompt === "string" ? prompt : await prompt(tx, id);
      if (text === null) return null;
      await insertRun(tx, {
        id,
        chatId,
        lane: `trigger:${row.id}`,
        teammateId: row.teammateId,
        trigger: row.kind,
        triggerId: row.id,
        prompt: text,
        readOutsideData: options.readOutsideData ?? false,
      });
      await tx.update(triggers).set({ lastFiredAt: new Date() }).where(eq(triggers.id, row.id));
      return id;
    });
    if (runId) await announceRun(this.ctx, chatId);
    return runId;
  }
}

/** Gives a new teammate these page watches, paused like its routines. */
export async function addPausedWatches(
  tx: Queryable,
  teammateId: string,
  watches: readonly {
    title: string;
    prompt: string;
    url: string;
    intervalMinutes: number;
    lookFor: string | null;
  }[],
): Promise<void> {
  if (watches.length === 0) return;
  await tx.insert(triggers).values(
    watches.map((watch) => ({
      teammateId,
      kind: "watch" as const,
      ...watch,
      enabled: false,
      createdBy: "user" as const,
    })),
  );
}

/** When an account trigger is checked next. */
export async function setNextTriggerCheck(db: Queryable, id: string, at: Date): Promise<void> {
  await db.update(triggers).set({ nextCheckAt: at }).where(eq(triggers.id, id));
}

/** How an account trigger's check went: when, its error, where it read up to, and whether it fired. */
export async function recordTriggerCheck(
  db: Queryable,
  id: string,
  result: { error?: string | null; cursor?: string; fired?: boolean },
): Promise<void> {
  const now = new Date();
  await db
    .update(triggers)
    .set({
      lastCheckedAt: now,
      lastError: result.error ?? null,
      ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
      ...(result.fired ? { lastFiredAt: now } : {}),
    })
    .where(eq(triggers.id, id));
}

/** Pauses every automation trigger a teammate has, in the caller's transaction (archiving it). */
export async function pauseTriggersOf(tx: Tx, teammateId: string): Promise<void> {
  await tx.update(triggers).set({ enabled: false }).where(eq(triggers.teammateId, teammateId));
}
