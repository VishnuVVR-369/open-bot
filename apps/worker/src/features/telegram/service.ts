import { randomBytes } from "node:crypto";
import type { TelegramStatus } from "@open-bot/api/worker";
import { credentials, telegram } from "@open-bot/db";
import { newLinkCode } from "@open-bot/domain";
import { decryptSecret, secretHint } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { errorMessage } from "../../logger";
import type { RunExecutor } from "../../runs/executor";
import type { UploadService } from "../uploads";
import type { ApprovalService } from "../approvals";
import { removeCredential, saveCredential } from "../credentials";
import { call, send, TelegramError, type TgUser } from "./api";
import { approvalDecided } from "./approvals";
import { onNotification } from "./notifications";
import { listen } from "./polling";

const LINK_CODE_MINUTES = 15;

export type { TelegramStatus };

/**
 * Your teammates on Telegram: notifications, approvals with buttons, and chat. Messages go to the
 * teammate you name (or the one you last talked to), and replies come back to Telegram. Only the
 * Telegram chat you link with a one-time code can use the bot.
 */
export class TelegramService {
  token: string | null = null;
  running = false;
  abort: AbortController | null = null;
  problem: string | null = null;
  /** Bumped on every (re)start, so an old poll loop stops when a new one begins. */
  generation = 0;

  constructor(
    readonly ctx: Context,
    readonly executor: RunExecutor,
    readonly approvalService: ApprovalService,
    readonly uploads: Pick<UploadService, "save">,
  ) {
    ctx.events.on("notification", (event) => {
      void onNotification(this, event).catch((error: unknown) =>
        ctx.log.warn("couldn't send a notification to Telegram", { error: errorMessage(error) }),
      );
    });
    ctx.events.on("approvalDecided", (approvalId) => {
      void approvalDecided(this, approvalId).catch((error: unknown) =>
        ctx.log.warn("couldn't update an approval's buttons in Telegram", {
          error: errorMessage(error),
        }),
      );
    });
  }

  async status(): Promise<TelegramStatus> {
    const [row] = await this.ctx.db.select().from(telegram).where(eq(telegram.id, 1));
    return {
      connected: Boolean(this.token),
      botUsername: row?.botUsername ?? null,
      tokenHint: this.token ? secretHint(this.token) : null,
      linked: Boolean(row?.chatId),
      linkedName: row?.linkedName ?? null,
      problem: this.problem,
    };
  }

  /** Load the stored token and start listening. */
  async start(): Promise<void> {
    const [row] = await this.ctx.db
      .select({ encrypted: credentials.encrypted })
      .from(credentials)
      .where(eq(credentials.kind, "telegram_bot_token"));
    if (!row) return;
    try {
      this.token = decryptSecret(row.encrypted, this.ctx.env.ENCRYPTION_KEY);
    } catch (error) {
      this.ctx.log.error("the stored Telegram token can't be decrypted", {
        error: errorMessage(error),
      });
      return;
    }
    listen(this);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.abort?.abort();
  }

  /** Connect a bot made with @BotFather. A different bot unlinks your chat. */
  async connect(token: string): Promise<TelegramStatus> {
    const clean = token.trim();
    if (!/^\d{5,}:[\w-]{30,}$/.test(clean))
      throw new TelegramError(
        "That doesn't look like a bot token. Copy the whole token from @BotFather.",
      );
    let me: TgUser & { is_bot: boolean };
    try {
      me = await call(this, "getMe", {}, { token: clean });
    } catch (error) {
      throw new TelegramError(
        error instanceof TelegramError && error.code === 401
          ? "Telegram didn't accept that token. Check it with @BotFather."
          : errorMessage(error),
      );
    }
    // Updates come by polling, which Telegram refuses while a webhook is set.
    await call(this, "deleteWebhook", { drop_pending_updates: false }, { token: clean });
    const [existing] = await this.ctx.db.select().from(telegram).where(eq(telegram.id, 1));
    const sameBot = existing?.botUsername === me.username;
    await saveCredential(this.ctx, "telegram_bot_token", clean);
    const fields = sameBot
      ? { botUsername: me.username ?? null }
      : {
          botUsername: me.username ?? null,
          chatId: null,
          linkedName: null,
          linkCode: null,
          linkCodeExpiresAt: null,
          updateOffset: 0,
          lastChatId: null,
        };
    await this.ctx.db
      .insert(telegram)
      .values({ id: 1, ...fields })
      .onConflictDoUpdate({ target: telegram.id, set: fields });
    this.token = clean;
    this.problem = null;
    listen(this);
    await publishApp(this.ctx, { type: "telegram" });
    return this.status();
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.token = null;
    this.problem = null;
    await removeCredential(this.ctx.db, "telegram_bot_token");
    await this.ctx.db.delete(telegram).where(eq(telegram.id, 1));
    await publishApp(this.ctx, { type: "telegram" });
  }

  /** A one-time code that links the Telegram chat that sends it. */
  async linkCode(): Promise<{ code: string; url: string; expiresAt: string }> {
    const [row] = await this.ctx.db.select().from(telegram).where(eq(telegram.id, 1));
    if (!this.token || !row?.botUsername) throw new TelegramError("Connect a Telegram bot first.");
    const code = newLinkCode((size) => randomBytes(size));
    const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60_000);
    await this.ctx.db
      .update(telegram)
      .set({ linkCode: code, linkCodeExpiresAt: expiresAt })
      .where(eq(telegram.id, 1));
    return {
      code,
      url: `https://t.me/${row.botUsername}?start=${code}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async unlink(): Promise<void> {
    await this.ctx.db
      .update(telegram)
      .set({ chatId: null, linkedName: null, lastChatId: null })
      .where(eq(telegram.id, 1));
    await publishApp(this.ctx, { type: "telegram" });
  }

  async sendTest(): Promise<void> {
    const chatId = await this.linkedChat();
    if (!chatId) throw new TelegramError("Link your Telegram account first.");
    await send(
      this,
      chatId,
      "👋 <b>open-bot is connected.</b>\nYou'll get approvals and updates here, and you can message your teammates. Send /help to see how.",
    );
  }

  async linkedChat(): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ chatId: telegram.chatId })
      .from(telegram)
      .where(eq(telegram.id, 1));
    return row?.chatId ?? null;
  }
}
