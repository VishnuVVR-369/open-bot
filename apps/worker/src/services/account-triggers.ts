import { connections, ownerTimeZone, runs, triggerFirings, triggers } from "@open-bot/db";
import {
  AccountToolError,
  CalendarApi,
  cap,
  eventDetails,
  GmailApi,
  header,
  messageContent,
  ProviderError,
  readableTime,
  type CalendarEvent,
  type GmailMessage,
  type ResolvedConnection,
} from "@open-bot/integrations/adapters";
import {
  ACCOUNT_TRIGGER_NOTE,
  CALENDAR_POLL_MINUTES,
  describeGmailQuery,
  GMAIL_POLL_MINUTES,
  integration,
  isCalendarEventFilter,
  outsideData,
  TRIGGER_CONNECTION_KIND,
  type AccountTriggerKind,
} from "@open-bot/domain";
import { and, count, eq, gte, inArray, like, lt, lte } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { errorMessage } from "../logger";
import type { AccountAccess } from "../accounts/access";
import {
  addedMessages,
  calendarWindow,
  dueOccurrences,
  gmailMatchQuery,
  messageKey,
  oldestHistoryId,
  startsIn,
  type HistoryRecord,
} from "./account-watch";
import {
  ACCOUNT_TRIGGER_RUNS_PER_HOUR,
  recordTriggerCheck,
  setNextTriggerCheck,
  TriggerError,
  type CheckResult,
  type Trigger,
  type TriggerService,
} from "./triggers";

const TICK_MS = 30_000;
/** A run is told about this many new messages in full; more are listed by subject. */
const MAX_MESSAGES_IN_FULL = 10;
const MAX_MESSAGE_TEXT = 6_000;
const MAX_PROMPT_TEXT = 60_000;
/** Gmail returns history in pages; a mailbox this far behind catches up over the next checks. */
const MAX_HISTORY_PAGES = 10;
/** When Gmail no longer has the history (a long outage), mail from this far back is looked at. */
const FALLBACK_DAYS = 1;
/** Event firings only matter until the event is over; mail firings are kept for good. */
const EVENT_FIRINGS_KEPT_MS = 14 * 24 * 60 * 60_000;
const CLEANUP_EVERY_MS = 60 * 60_000;

interface Due {
  trigger: Trigger;
  accountId: string;
}

/** Why a check couldn't run, for you on the Automations page. */
class CheckProblem extends Error {}

/**
 * Gmail and Calendar triggers. Gmail is checked every 2 minutes per mailbox with one
 * history.list for all of its triggers; Calendar every 5 minutes per trigger, over the events
 * whose lead time is coming up. What woke a teammate is remembered in `trigger_firings`, so the
 * same message or event occurrence never wakes it twice, and its run starts as one that read
 * outside data.
 */
export class AccountTriggers {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private cleanedAt = 0;

  constructor(
    private readonly ctx: Context,
    private readonly access: AccountAccess,
    private readonly triggers: TriggerService,
  ) {
    triggers.onAccountTriggerChange(() => this.kick());
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Check what's due now. A kick during a check runs another pass right after it. */
  kick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.tick()
      .catch((error: unknown) =>
        this.ctx.log.error("account trigger tick failed", { error: errorMessage(error) }),
      )
      .finally(() => {
        this.ticking = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Check one trigger now, from the Automations page, without changing when it checks next. */
  async checkNow(id: string): Promise<CheckResult> {
    const [row] = await this.ctx.db
      .select({ trigger: triggers, accountId: connections.accountId })
      .from(triggers)
      .innerJoin(connections, eq(connections.id, triggers.connectionId))
      .where(eq(triggers.id, id));
    if (!row || (row.trigger.kind !== "gmail" && row.trigger.kind !== "calendar"))
      throw new TriggerError("That automation no longer exists.");
    const due = { trigger: row.trigger, accountId: row.accountId! };
    return row.trigger.kind === "gmail" ? this.checkMailbox([due]) : this.checkCalendar(due);
  }

  private async tick(): Promise<void> {
    const due = await this.claim();
    const mailboxes = new Map<string, Due[]>();
    for (const entry of due.filter((entry) => entry.trigger.kind === "gmail")) {
      const list = mailboxes.get(entry.accountId) ?? [];
      list.push(entry);
      mailboxes.set(entry.accountId, list);
    }
    await Promise.all([
      ...[...mailboxes.values()].map((list) => this.checkMailbox(list)),
      ...due
        .filter((entry) => entry.trigger.kind === "calendar")
        .map((entry) => this.checkCalendar(entry)),
    ]);
    if (Date.now() - this.cleanedAt > CLEANUP_EVERY_MS) {
      this.cleanedAt = Date.now();
      await this.ctx.db
        .delete(triggerFirings)
        .where(
          and(
            like(triggerFirings.key, "event:%"),
            lt(triggerFirings.createdAt, new Date(Date.now() - EVENT_FIRINGS_KEPT_MS)),
          ),
        );
    }
  }

  /**
   * Claim due triggers by moving their next check forward, so a slow check never runs twice. A
   * mailbox's Gmail triggers are all checked together once any is due, so one history.list serves
   * them all.
   */
  private async claim(): Promise<Due[]> {
    return this.ctx.db.transaction(async (tx) => {
      const now = new Date();
      const due = await tx
        .select({ trigger: triggers, accountId: connections.accountId })
        .from(triggers)
        .innerJoin(connections, eq(connections.id, triggers.connectionId))
        .where(
          and(
            inArray(triggers.kind, ["gmail", "calendar"]),
            eq(triggers.enabled, true),
            lte(triggers.nextCheckAt, now),
          ),
        )
        .for("update", { of: triggers, skipLocked: true });
      const mailboxes = [
        ...new Set(due.filter((row) => row.trigger.kind === "gmail").map((row) => row.accountId!)),
      ];
      const siblings = mailboxes.length
        ? await tx
            .select({ trigger: triggers, accountId: connections.accountId })
            .from(triggers)
            .innerJoin(connections, eq(connections.id, triggers.connectionId))
            .where(
              and(
                eq(triggers.kind, "gmail"),
                eq(triggers.enabled, true),
                inArray(connections.accountId, mailboxes),
              ),
            )
            .for("update", { of: triggers, skipLocked: true })
        : [];
      const claimed = new Map<string, Due>();
      for (const row of [...due, ...siblings])
        claimed.set(row.trigger.id, { trigger: row.trigger, accountId: row.accountId! });
      for (const { trigger } of claimed.values()) {
        const minutes = trigger.kind === "gmail" ? GMAIL_POLL_MINUTES : CALENDAR_POLL_MINUTES;
        await setNextTriggerCheck(tx, trigger.id, new Date(now.getTime() + minutes * 60_000));
      }
      return [...claimed.values()];
    });
  }

  /**
   * The connection a trigger watches, if its teammate may still read it. A lost sign-in is told to
   * you once by AccountAccess; here it only marks the trigger, so nothing repeats every check.
   */
  private async connectionFor(trigger: Trigger): Promise<ResolvedConnection> {
    const kind = TRIGGER_CONNECTION_KIND[trigger.kind as AccountTriggerKind];
    const label = integration(kind).label;
    const options = await this.access.forBot(trigger.botId, kind);
    const resolved = options.find((option) => option.connection.id === trigger.connectionId);
    if (!resolved) {
      const [row] = await this.ctx.db
        .select({ enabled: connections.enabled })
        .from(connections)
        .where(eq(connections.id, trigger.connectionId!));
      throw new CheckProblem(
        row && !row.enabled
          ? `${label} is turned off in Settings → Connections.`
          : `The teammate no longer has access to ${label}.`,
      );
    }
    if (resolved.account.status !== "connected")
      throw new CheckProblem(`${label} needs reconnecting in Settings → Connections.`);
    try {
      this.access.requireCapability(resolved, "read");
    } catch {
      throw new CheckProblem(
        `${label} doesn't allow reading. Reconnect it in Settings → Connections.`,
      );
    }
    return resolved;
  }

  private problemText(error: unknown, trigger: Trigger): string {
    const label = integration(TRIGGER_CONNECTION_KIND[trigger.kind as AccountTriggerKind]).label;
    if (error instanceof CheckProblem) return error.message;
    if (error instanceof AccountToolError)
      return `The sign-in to ${label} stopped working. Reconnect it in Settings → Connections.`;
    if (error instanceof ProviderError)
      return error.reason === "accessNotConfigured" || error.reason === "SERVICE_DISABLED"
        ? `The ${label} API isn't enabled in your Google Cloud project.`
        : `${label} answered: ${error.message}`;
    return errorMessage(error);
  }

  /** Save how a check went. */
  private async checked(
    id: string,
    result: { error?: string | null; cursor?: string; fired?: boolean },
  ): Promise<void> {
    await recordTriggerCheck(this.ctx.db, id, result);
  }

  /** Remember these keys as fired; returns the ones that weren't already. */
  private async claimKeys(triggerId: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.ctx.db
      .insert(triggerFirings)
      .values(keys.map((key) => ({ triggerId, key })))
      .onConflictDoNothing()
      .returning({ key: triggerFirings.key });
    return new Set(rows.map((row) => row.key));
  }

  private async runsLastHour(triggerId: string): Promise<number> {
    const [row] = await this.ctx.db
      .select({ value: count() })
      .from(runs)
      .where(
        and(eq(runs.triggerId, triggerId), gte(runs.createdAt, new Date(Date.now() - 3_600_000))),
      );
    return row?.value ?? 0;
  }

  /** Start the teammate, within the hourly limit. Returns why it didn't, if it didn't. */
  private async fire(trigger: Trigger, prompt: string, keys: string[]): Promise<string | null> {
    if ((await this.runsLastHour(trigger.id)) >= ACCOUNT_TRIGGER_RUNS_PER_HOUR)
      return `Skipped: it already started ${ACCOUNT_TRIGGER_RUNS_PER_HOUR} runs in the last hour.`;
    const runId = await this.triggers.fire(trigger, prompt, { readOutsideData: true });
    if (!runId) return "Skipped: its teammate is archived.";
    await this.ctx.db
      .update(triggerFirings)
      .set({ runId })
      .where(and(eq(triggerFirings.triggerId, trigger.id), inArray(triggerFirings.key, keys)));
    return null;
  }

  /* -------------------------------------------------------------- Gmail */

  /** New mail in one mailbox, for each of its triggers. */
  private async checkMailbox(due: Due[]): Promise<CheckResult> {
    const usable: { trigger: Trigger; resolved: ResolvedConnection }[] = [];
    let problem = "Couldn't check the mailbox.";
    for (const { trigger } of due) {
      try {
        usable.push({ trigger, resolved: await this.connectionFor(trigger) });
      } catch (error) {
        problem = this.problemText(error, trigger);
        await this.checked(trigger.id, { error: problem });
      }
    }
    if (usable.length === 0) {
      await publishApp(this.ctx, { type: "triggers" });
      return { ok: false, changed: false, summary: problem };
    }
    const api = new GmailApi(this.access.tokens(usable[0]!.resolved));
    let result: CheckResult = { ok: true, changed: false, summary: "No new mail" };
    try {
      const fresh = usable.filter(({ trigger }) => trigger.cursor === null);
      const going = usable.filter(({ trigger }) => trigger.cursor !== null);
      // A new or resumed trigger starts from the mailbox as it is now.
      if (fresh.length) {
        const profile = await api.get<{ historyId: string }>("/profile");
        for (const { trigger } of fresh)
          await this.checked(trigger.id, { cursor: profile.historyId });
        result = { ok: true, changed: false, summary: "Watching for new mail from now on" };
      }
      if (going.length) {
        const history = await this.history(
          api,
          oldestHistoryId(going.map(({ trigger }) => trigger.cursor!))!,
        );
        let fired = 0;
        for (const { trigger, resolved } of going) {
          try {
            const candidates = history.records
              ? addedMessages(history.records, trigger.cursor)
              : await this.recentMatches(api, trigger.query, FALLBACK_DAYS);
            const matched = history.records
              ? await this.matching(api, trigger.query, candidates)
              : candidates;
            const outcome = await this.fireForMail(api, trigger, resolved, matched);
            if (outcome.fired) fired += outcome.count;
            await this.checked(trigger.id, {
              cursor: history.cursor,
              fired: outcome.fired,
              error: outcome.skipped,
            });
          } catch (error) {
            await this.checked(trigger.id, { error: this.problemText(error, trigger) });
            if (due.length === 1)
              result = { ok: false, changed: false, summary: this.problemText(error, trigger) };
          }
        }
        if (fired > 0)
          result = {
            ok: true,
            changed: true,
            summary: `${fired} new email${fired === 1 ? "" : "s"}`,
          };
      }
    } catch (error) {
      const message = this.problemText(error, usable[0]!.trigger);
      for (const { trigger } of usable) await this.checked(trigger.id, { error: message });
      result = { ok: false, changed: false, summary: message };
    }
    await publishApp(this.ctx, { type: "triggers" });
    return result;
  }

  /**
   * What changed in the mailbox since `start`. Gmail keeps about a week of history; when `start`
   * is older, `records` is null and the caller looks at recent mail instead.
   */
  private async history(
    api: GmailApi,
    start: string,
  ): Promise<{ records: HistoryRecord[] | null; cursor: string }> {
    const records: HistoryRecord[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      let body: { history?: HistoryRecord[]; historyId: string; nextPageToken?: string };
      try {
        body = await api.get("/history", {
          startHistoryId: start,
          historyTypes: "messageAdded",
          maxResults: 500,
          pageToken,
        });
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) {
          const profile = await api.get<{ historyId: string }>("/profile");
          return { records: null, cursor: profile.historyId };
        }
        throw error;
      }
      records.push(...(body.history ?? []));
      if (!body.nextPageToken) return { records, cursor: body.historyId };
      pageToken = body.nextPageToken;
    }
    // Far behind: carry on from the last record read, next time.
    return { records, cursor: records[records.length - 1]?.id ?? start };
  }

  /** Which of the new messages match the trigger's search. */
  private async matching(
    api: GmailApi,
    query: string | null,
    candidates: { id: string; threadId: string }[],
  ): Promise<{ id: string; threadId: string }[]> {
    if (candidates.length === 0) return [];
    const found = await this.recentMatches(api, query, 2);
    const ids = new Set(found.map((message) => message.id));
    return candidates.filter((message) => ids.has(message.id));
  }

  private async recentMatches(
    api: GmailApi,
    query: string | null,
    days: number,
  ): Promise<{ id: string; threadId: string }[]> {
    const { messages = [] } = await api.get<{ messages?: { id: string; threadId: string }[] }>(
      "/messages",
      { q: gmailMatchQuery(query, days), maxResults: 100 },
    );
    return messages;
  }

  private async fireForMail(
    api: GmailApi,
    trigger: Trigger,
    resolved: ResolvedConnection,
    matched: { id: string; threadId: string }[],
  ): Promise<{ fired: boolean; count: number; skipped: string | null }> {
    if (matched.length === 0) return { fired: false, count: 0, skipped: null };
    const known = await this.ctx.db
      .select({ key: triggerFirings.key })
      .from(triggerFirings)
      .where(
        and(
          eq(triggerFirings.triggerId, trigger.id),
          inArray(
            triggerFirings.key,
            matched.map((message) => messageKey(message.id)),
          ),
        ),
      );
    const seen = new Set(known.map((row) => row.key));
    const unseen = matched.filter((message) => !seen.has(messageKey(message.id)));
    if (unseen.length === 0) return { fired: false, count: 0, skipped: null };
    // Read the mail first, so a failed read leaves it to wake the teammate next time.
    const messages: GmailMessage[] = [];
    for (const { id } of unseen)
      messages.push(
        await api.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" }),
      );
    // Then claim it: whatever another check claimed first is theirs to report.
    const claimed = await this.claimKeys(
      trigger.id,
      messages.map((message) => messageKey(message.id)),
    );
    // Mail from before the trigger existed isn't news, even when a catch-up finds it.
    const created = trigger.createdAt.getTime();
    const news = messages
      .filter((message) => claimed.has(messageKey(message.id)))
      .filter((message) => Number(message.internalDate ?? Date.now()) >= created - 60_000)
      .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    if (news.length === 0) return { fired: false, count: 0, skipped: null };
    const skipped = await this.fire(
      trigger,
      this.mailPrompt(trigger, resolved, news),
      news.map((message) => messageKey(message.id)),
    );
    return { fired: skipped === null, count: news.length, skipped };
  }

  private mailPrompt(
    trigger: Trigger,
    resolved: ResolvedConnection,
    messages: GmailMessage[],
  ): string {
    const shown = messages.slice(-MAX_MESSAGES_IN_FULL);
    const earlier = messages.slice(0, messages.length - shown.length);
    const parts = shown.map((message) => {
      const content = message.payload
        ? messageContent(message.payload)
        : { text: "", attachments: [] };
      return [
        `--- message ${message.id} in thread ${message.threadId}`,
        `From: ${header(message, "From")}`,
        `To: ${header(message, "To")}`,
        ...(header(message, "Cc") ? [`Cc: ${header(message, "Cc")}`] : []),
        `Date: ${header(message, "Date")}`,
        `Subject: ${header(message, "Subject") || "(no subject)"}`,
        ...(content.attachments.length
          ? [`Attachments: ${content.attachments.map((attachment) => attachment.name).join(", ")}`]
          : []),
        "",
        cap(content.text || message.snippet || "(no text)", MAX_MESSAGE_TEXT),
      ].join("\n");
    });
    if (earlier.length)
      parts.unshift(
        `${earlier.length} earlier new message${earlier.length === 1 ? "" : "s"}, not shown in full:\n${earlier
          .map(
            (message) =>
              `- ${message.id}: “${header(message, "Subject") || "(no subject)"}” from ${header(message, "From")}`,
          )
          .join("\n")}`,
      );
    const count = messages.length === 1 ? "A new email" : `${messages.length} new emails`;
    return [
      `[Gmail: "${trigger.title}"]`,
      "",
      trigger.prompt,
      "",
      `${count} arrived in ${resolved.account.display} (${describeGmailQuery(trigger.query)}). Read a whole thread with gmail.read_thread, and use the other gmail tools if your instructions call for it. ${ACCOUNT_TRIGGER_NOTE}`,
      "",
      outsideData(
        `From Gmail (${resolved.account.display}): ${messages.length === 1 ? "the new message" : "the new messages, oldest first"}`,
        cap(parts.join("\n\n"), MAX_PROMPT_TEXT),
      ),
    ].join("\n");
  }

  /* -------------------------------------------------------------- Calendar */

  /** Events whose lead time has come, each waking the teammate once for the time it's at. */
  private async checkCalendar({ trigger }: Due): Promise<CheckResult> {
    let result: CheckResult;
    try {
      const resolved = await this.connectionFor(trigger);
      const api = new CalendarApi(this.access.tokens(resolved));
      const now = new Date();
      const leadMinutes = trigger.leadMinutes ?? 30;
      const filter = isCalendarEventFilter(trigger.query) ? trigger.query : "all";
      const { items = [] } = await api.get<{ items?: CalendarEvent[] }>(
        "/calendars/primary/events",
        {
          ...calendarWindow(now, leadMinutes, CALENDAR_POLL_MINUTES),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 100,
        },
      );
      const due = dueOccurrences(items, {
        now,
        leadMinutes,
        pollMinutes: CALENDAR_POLL_MINUTES,
        filter,
      });
      const fresh = await this.claimKeys(
        trigger.id,
        due.map((entry) => entry.key),
      );
      const timeZone = await ownerTimeZone(this.ctx.db);
      let fired = 0;
      let skipped: string | null = null;
      for (const entry of due.filter((entry) => fresh.has(entry.key))) {
        const event = entry.event as CalendarEvent;
        const prompt = [
          `[Calendar: "${trigger.title}"]`,
          "",
          trigger.prompt,
          "",
          `“${event.summary ?? "An event"}” ${startsIn(entry.startsAt, now)}, at ${readableTime(entry.startsAt, timeZone)} (${timeZone}), on ${resolved.account.display}'s calendar. ${ACCOUNT_TRIGGER_NOTE}`,
          "",
          outsideData(
            `From Google Calendar (${resolved.account.display}): event ${event.id}. Titles, places and descriptions can be written by anyone who invites the user`,
            eventDetails(event, timeZone),
          ),
        ].join("\n");
        skipped = await this.fire(trigger, prompt, [entry.key]);
        if (skipped) break;
        fired += 1;
      }
      await this.checked(trigger.id, { fired: fired > 0, error: skipped });
      result =
        fired > 0
          ? {
              ok: true,
              changed: true,
              summary: `${fired} event${fired === 1 ? "" : "s"} coming up`,
            }
          : skipped
            ? { ok: false, changed: false, summary: skipped }
            : { ok: true, changed: false, summary: "Nothing coming up yet" };
    } catch (error) {
      const message = this.problemText(error, trigger);
      await this.checked(trigger.id, { error: message });
      result = { ok: false, changed: false, summary: message };
    }
    await publishApp(this.ctx, { type: "triggers" });
    return result;
  }
}
