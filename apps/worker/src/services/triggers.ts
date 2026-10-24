import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { bots, runs, triggers } from "@open-bot/db";
import {
  describeInterval,
  describeWatchChange,
  invalidWatchUrl,
  isPrivateAddress,
  MAX_WATCH_MINUTES,
  MIN_WATCH_MINUTES,
  PAGE_TEXT_NOTE,
  pageText,
  summarizeWatchChange,
  watchChange,
  WEBHOOK_PAYLOAD_NOTE,
  type TriggerKind,
} from "@open-bot/shared";
import { and, count, eq, gte, lte } from "drizzle-orm";
import { enqueueRun, publishApp, type Context } from "../context";
import { errorMessage } from "../logger";
import { scheduledChatFor } from "./schedules";

export type Trigger = typeof triggers.$inferSelect;

const TICK_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Checks running at once, so many watches due together don't flood the network. */
const CHECK_CONCURRENCY = 4;
/** A webhook can start at most this many runs an hour, so a noisy sender can't run up a bill. */
export const WEBHOOK_RUNS_PER_HOUR = 30;
const MAX_PAYLOAD_CHARS = 20_000;

export class TriggerError extends Error {}

export interface TriggerInput {
  botId: string;
  kind: TriggerKind;
  title: string;
  prompt: string;
  url?: string | null;
  intervalMinutes?: number | null;
  lookFor?: string | null;
}

export interface CheckResult {
  ok: boolean;
  changed: boolean;
  summary: string;
}

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

/** Why a page couldn't be fetched, in plain words. */
function fetchFailure(error: unknown, url: URL): string {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "The page took too long to answer.";
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Couldn't find ${url.hostname}.`;
  if (code === "ECONNREFUSED") return `Nothing answered at ${url.host}.`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "The connection was cut off.";
  if (code.startsWith("UND_ERR_CONNECT_TIMEOUT") || code === "ETIMEDOUT")
    return "The page took too long to answer.";
  if (/CERT|SSL|TLS/i.test(code)) return "The page's security certificate isn't valid.";
  if (cause?.message === "bad port") return `Browsers don't allow port ${url.port}.`;
  return "Couldn't reach the page.";
}

/** Watches and webhooks: wake a teammate when a page changes or a service calls it. */
export class TriggerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;

  constructor(private readonly ctx: Context) {}

  /** The address services call to fire a webhook. */
  webhookUrl(token: string): string {
    return `${this.ctx.env.APP_URL.replace(/\/+$/, "")}/api/hooks/${token}`;
  }

  private validate(input: TriggerInput) {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title) throw new TriggerError("Give it a name.");
    if (title.length > 80) throw new TriggerError("Keep the name under 80 characters.");
    if (!prompt) throw new TriggerError("Say what the teammate should do when it fires.");
    if (prompt.length > 4000)
      throw new TriggerError("Keep the instructions under 4000 characters.");
    if (input.kind === "webhook")
      return { title, prompt, url: null, intervalMinutes: null, lookFor: null };
    const url = input.url?.trim() ?? "";
    const problem = invalidWatchUrl(url);
    if (problem) throw new TriggerError(problem);
    const intervalMinutes = Math.round(input.intervalMinutes ?? 60);
    if (intervalMinutes < MIN_WATCH_MINUTES || intervalMinutes > MAX_WATCH_MINUTES)
      throw new TriggerError(`Check between every ${MIN_WATCH_MINUTES} minutes and once a week.`);
    const lookFor = input.lookFor?.trim().slice(0, 200) || null;
    return { title, prompt, url, intervalMinutes, lookFor };
  }

  async create(
    input: TriggerInput,
    by: { kind: "user" } | { kind: "bot"; runId: string },
  ): Promise<Trigger> {
    const fields = this.validate(input);
    const [row] = await this.ctx.db
      .insert(triggers)
      .values({
        botId: input.botId,
        kind: input.kind,
        ...fields,
        token: input.kind === "webhook" ? newToken() : null,
        // A new watch checks right away, to learn what the page looks like.
        nextCheckAt: input.kind === "watch" ? new Date() : null,
        createdBy: by.kind,
        createdByRunId: by.kind === "bot" ? by.runId : null,
      })
      .returning();
    await publishApp(this.ctx, { type: "triggers" });
    this.kick();
    return row!;
  }

  async update(id: string, input: TriggerInput): Promise<Trigger> {
    const [existing] = await this.ctx.db.select().from(triggers).where(eq(triggers.id, id));
    if (!existing) throw new TriggerError("That automation no longer exists.");
    if (existing.kind !== input.kind)
      throw new TriggerError("An automation can't change its kind.");
    const fields = this.validate(input);
    // A watch on a new page, or looking for new text, starts over from a fresh look at the page.
    const restart =
      existing.kind === "watch" &&
      (existing.url !== fields.url || existing.lookFor !== fields.lookFor);
    const [row] = await this.ctx.db
      .update(triggers)
      .set({
        botId: input.botId,
        ...fields,
        ...(restart ? { snapshot: null, lastError: null, nextCheckAt: new Date() } : {}),
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
    this.kick();
    return row!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const [row] = await this.ctx.db
      .update(triggers)
      .set({ enabled, ...(enabled ? { nextCheckAt: new Date() } : {}) })
      .where(eq(triggers.id, id))
      .returning({ kind: triggers.kind });
    if (!row) throw new TriggerError("That automation no longer exists.");
    await publishApp(this.ctx, { type: "triggers" });
    this.kick();
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

  async forBot(botId: string): Promise<Trigger[]> {
    return this.ctx.db.select().from(triggers).where(eq(triggers.botId, botId));
  }

  /** The bot's own watches and webhooks, as it reads them. */
  async describeForBot(botId: string): Promise<string | null> {
    const rows = await this.forBot(botId);
    if (rows.length === 0) return null;
    return rows
      .map((row) => {
        const state = row.enabled ? "on" : "paused";
        if (row.kind === "webhook")
          return `- ${row.id}: webhook "${row.title}", ${state}, URL ${this.webhookUrl(row.token!)}`;
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
    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, row.botId));
    if (!bot || bot.archivedAt)
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
      text = await this.fetchPage(row.url!);
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
    await this.ctx.db
      .update(triggers)
      .set({
        snapshot: text,
        lastCheckedAt: now,
        lastError: null,
        ...(change ? { lastFiredAt: now } : {}),
      })
      .where(eq(triggers.id, row.id));
    if (change) {
      const summary = summarizeWatchChange(change);
      await this.fire(
        row,
        `[Watch: "${row.title}"]\n\n${row.prompt}\n\nThe page ${row.url} changed since the last check (${summary}). ${PAGE_TEXT_NOTE}\n\n${describeWatchChange(change)}`,
      );
      await publishApp(this.ctx, { type: "triggers" });
      return { ok: true, changed: true, summary };
    }
    await publishApp(this.ctx, { type: "triggers" });
    return {
      ok: true,
      changed: false,
      summary: row.snapshot === null ? "Saw the page for the first time" : "No change",
    };
  }

  /** The page's text, following redirects and refusing private network addresses. */
  private async fetchPage(start: string): Promise<string> {
    let url = new URL(start);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await this.assertPublic(url);
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      }).catch((error: unknown) => {
        throw new Error(fetchFailure(error, url));
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new Error(`The page redirected (${response.status}) without saying where.`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok)
        throw new Error(`The page answered ${response.status} ${response.statusText}.`);
      const body = await this.readLimited(response);
      return pageText(body, response.headers.get("content-type") ?? "");
    }
    throw new Error("The page redirected too many times.");
  }

  private async assertPublic(url: URL) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only http and https pages can be watched.");
    if (this.ctx.env.WATCH_ALLOW_PRIVATE_URLS) return;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true }).catch(() => {
      throw new Error(`Couldn't find ${host}.`);
    });
    if (addresses.some((entry) => isPrivateAddress(entry.address)))
      throw new Error("Pages on a private network can't be watched.");
  }

  private async readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  /* -------------------------------------------------------------- Firing */

  private async fire(row: Trigger, prompt: string): Promise<string | null> {
    const [bot] = await this.ctx.db
      .select({ archivedAt: bots.archivedAt })
      .from(bots)
      .where(eq(bots.id, row.botId));
    if (!bot || bot.archivedAt) return null;
    const chatId = await scheduledChatFor(this.ctx, row.botId);
    await this.ctx.db
      .update(triggers)
      .set({ lastFiredAt: new Date() })
      .where(eq(triggers.id, row.id));
    return enqueueRun(this.ctx, {
      chatId,
      botId: row.botId,
      trigger: row.kind,
      triggerId: row.id,
      prompt,
    });
  }
}
