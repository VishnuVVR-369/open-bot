import { randomBytes } from "node:crypto";
import {
  approvals,
  bots,
  chats,
  credentials,
  messages,
  runs,
  telegram,
  telegramMessages,
  type Attachment,
} from "@open-bot/db";
import { newLinkCode, splitTelegram, telegramHtml, TELEGRAM_MAX_CHARS } from "@open-bot/shared";
import { decryptSecret, encryptSecret, secretHint } from "@open-bot/shared/secrets";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { publishApp, type Context, type NotificationEvent } from "../context";
import { errorMessage } from "../logger";
import type { RunExecutor } from "../runs/executor";
import { saveUpload } from "../uploads";
import type { ApprovalService } from "./approvals";

const POLL_SECONDS = 25;
const LINK_CODE_MINUTES = 15;
/** Telegram's limit on files a bot can download. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code = 0,
  ) {
    super(message);
  }
}

interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  photo?: { file_id: string; file_size?: number; width: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
}

type InlineKeyboard = { text: string; callback_data?: string; url?: string }[][];

export interface TelegramStatus {
  connected: boolean;
  botUsername: string | null;
  tokenHint: string | null;
  linked: boolean;
  linkedName: string | null;
  /** Why the connection isn't working, when it isn't. */
  problem: string | null;
}

function displayName(user: TgUser | undefined): string {
  if (!user) return "you";
  return user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Your teammates on Telegram: notifications, approvals with buttons, and chat. Messages go to the
 * teammate you name (or the one you last talked to), and replies come back to Telegram. Only the
 * Telegram chat you link with a one-time code can use the bot.
 */
export class TelegramService {
  private token: string | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private problem: string | null = null;
  /** Bumped on every (re)start, so an old poll loop stops when a new one begins. */
  private generation = 0;

  constructor(
    private readonly ctx: Context,
    private readonly executor: RunExecutor,
    private readonly approvalService: ApprovalService,
  ) {
    ctx.events.on("notification", (event) => {
      void this.onNotification(event).catch((error: unknown) =>
        ctx.log.warn("couldn't send a notification to Telegram", { error: errorMessage(error) }),
      );
    });
    ctx.events.on("approvalDecided", (approvalId) => {
      void this.approvalDecided(approvalId).catch(() => {});
    });
  }

  /* -------------------------------------------------------------- The Bot API */

  private async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const token = options.token ?? this.token;
    if (!token) throw new TelegramError("Telegram isn't connected.");
    const base = this.ctx.env.TELEGRAM_API_BASE_URL.replace(/\/+$/, "");
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new TelegramError("Couldn't reach Telegram.");
    }
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!data.ok)
      throw new TelegramError(
        data.description ?? `Telegram answered ${response.status}`,
        data.error_code ?? response.status,
      );
    return data.result as T;
  }

  private async download(fileId: string): Promise<{ path: string; dataBase64: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", {
      file_id: fileId,
    });
    if (!file.file_path) throw new TelegramError("Telegram didn't share that file.");
    const base = this.ctx.env.TELEGRAM_API_BASE_URL.replace(/\/+$/, "");
    const response = await fetch(`${base}/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new TelegramError("Couldn't download the file from Telegram.");
    const bytes = Buffer.from(await response.arrayBuffer());
    return { path: file.file_path, dataBase64: bytes.toString("base64") };
  }

  /** Send HTML, split to fit; falls back to plain text if Telegram can't parse the HTML. */
  private async send(
    chatId: string,
    html: string,
    options: { replyTo?: number; keyboard?: InlineKeyboard } = {},
  ): Promise<number[]> {
    const ids: number[] = [];
    const chunks = splitTelegram(html, TELEGRAM_MAX_CHARS);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(index === 0 && options.replyTo
          ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
          : {}),
        ...(last && options.keyboard
          ? { reply_markup: { inline_keyboard: options.keyboard } }
          : {}),
      };
      let sent: { message_id: number };
      try {
        sent = await this.call<{ message_id: number }>("sendMessage", params);
      } catch (error) {
        if (!(error instanceof TelegramError) || error.code !== 400) throw error;
        // Formatting Telegram couldn't parse, or a button it rejected: send it plain.
        const { parse_mode: _mode, reply_markup: markup, ...plain } = params;
        const keyboard = markup as { inline_keyboard: InlineKeyboard } | undefined;
        const safeKeyboard = keyboard?.inline_keyboard
          .map((row) => row.filter((button) => button.callback_data))
          .filter((row) => row.length);
        sent = await this.call<{ message_id: number }>("sendMessage", {
          ...plain,
          text: chunk
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&"),
          ...(safeKeyboard?.length ? { reply_markup: { inline_keyboard: safeKeyboard } } : {}),
        });
      }
      ids.push(sent.message_id);
    }
    return ids;
  }

  /* -------------------------------------------------------------- Setup */

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
    this.listen();
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
      me = await this.call("getMe", {}, { token: clean });
    } catch (error) {
      throw new TelegramError(
        error instanceof TelegramError && error.code === 401
          ? "Telegram didn't accept that token. Check it with @BotFather."
          : errorMessage(error),
      );
    }
    // Updates come by polling, which Telegram refuses while a webhook is set.
    await this.call("deleteWebhook", { drop_pending_updates: false }, { token: clean });
    const [existing] = await this.ctx.db.select().from(telegram).where(eq(telegram.id, 1));
    const sameBot = existing?.botUsername === me.username;
    await this.ctx.db
      .insert(credentials)
      .values({
        kind: "telegram_bot_token",
        encrypted: encryptSecret(clean, this.ctx.env.ENCRYPTION_KEY),
        hint: secretHint(clean),
      })
      .onConflictDoUpdate({
        target: credentials.kind,
        set: {
          encrypted: encryptSecret(clean, this.ctx.env.ENCRYPTION_KEY),
          hint: secretHint(clean),
        },
      });
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
    this.listen();
    await publishApp(this.ctx, { type: "telegram" });
    return this.status();
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.token = null;
    this.problem = null;
    await this.ctx.db.delete(credentials).where(eq(credentials.kind, "telegram_bot_token"));
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
    await this.send(
      chatId,
      "👋 <b>open-bot is connected.</b>\nYou'll get approvals and updates here, and you can message your teammates. Send /help to see how.",
    );
  }

  private async linkedChat(): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ chatId: telegram.chatId })
      .from(telegram)
      .where(eq(telegram.id, 1));
    return row?.chatId ?? null;
  }

  /* -------------------------------------------------------------- Receiving */

  private listen() {
    this.stop();
    this.running = true;
    const generation = this.generation;
    void this.loop(generation);
  }

  private async loop(generation: number) {
    let failures = 0;
    while (this.running && generation === this.generation && this.token) {
      this.abort = new AbortController();
      try {
        const [row] = await this.ctx.db
          .select({ offset: telegram.updateOffset })
          .from(telegram)
          .where(eq(telegram.id, 1));
        const updates = await this.call<TgUpdate[]>(
          "getUpdates",
          {
            offset: row?.offset ?? 0,
            timeout: POLL_SECONDS,
            allowed_updates: ["message", "callback_query"],
          },
          { timeoutMs: (POLL_SECONDS + 10) * 1000, signal: this.abort.signal },
        );
        if (generation !== this.generation) return;
        if (this.problem) {
          this.problem = null;
          await publishApp(this.ctx, { type: "telegram" });
        }
        failures = 0;
        for (const update of updates) {
          await this.handle(update).catch((error: unknown) =>
            this.ctx.log.error("a Telegram update failed", { error: errorMessage(error) }),
          );
          await this.ctx.db
            .update(telegram)
            .set({ updateOffset: update.update_id + 1 })
            .where(eq(telegram.id, 1));
        }
      } catch (error) {
        if (generation !== this.generation || !this.running) return;
        failures += 1;
        const unauthorized = error instanceof TelegramError && error.code === 401;
        const conflict = error instanceof TelegramError && error.code === 409;
        const problem = unauthorized
          ? "Telegram stopped accepting the bot token. Connect the bot again."
          : conflict
            ? "Another program is reading this bot's messages. Stop it, or make a new bot."
            : errorMessage(error);
        if (problem !== this.problem) {
          this.problem = problem;
          await publishApp(this.ctx, { type: "telegram" });
        }
        if (unauthorized) {
          this.running = false;
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** failures)),
        );
      }
    }
  }

  private async handle(update: TgUpdate) {
    if (update.callback_query) return this.onButton(update.callback_query);
    const message = update.message;
    if (!message || message.chat.type !== "private") return;
    const chatId = String(message.chat.id);
    const text = (message.text ?? message.caption ?? "").trim();
    const [row] = await this.ctx.db.select().from(telegram).where(eq(telegram.id, 1));

    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (start?.[1]) {
      const valid =
        row?.linkCode &&
        row.linkCodeExpiresAt &&
        row.linkCodeExpiresAt.getTime() > Date.now() &&
        start[1].toUpperCase() === row.linkCode;
      if (!valid) {
        await this.send(
          chatId,
          "That link code isn't valid anymore. Get a new one in open-bot's Settings.",
        );
        return;
      }
      await this.ctx.db
        .update(telegram)
        .set({
          chatId,
          linkedName: displayName(message.from),
          linkCode: null,
          linkCodeExpiresAt: null,
        })
        .where(eq(telegram.id, 1));
      await publishApp(this.ctx, { type: "telegram" });
      await this.send(
        chatId,
        `✅ <b>Linked.</b> You'll get approvals and updates from your teammates here.\n\n${await this.helpText()}`,
      );
      return;
    }
    // Everyone but the linked chat is turned away, without saying anything about your data.
    if (!row?.chatId || row.chatId !== chatId) {
      await this.send(
        chatId,
        "This is a private assistant. Link it from open-bot's Settings to use it.",
      );
      return;
    }
    if (/^\/(start|help)(@\w+)?$/.test(text)) {
      await this.send(chatId, await this.helpText());
      return;
    }
    if (/^\/team(@\w+)?$/.test(text)) {
      await this.send(chatId, await this.teamText());
      return;
    }
    await this.receive(row.lastChatId, message, text);
  }

  private async helpText(): Promise<string> {
    const lead = await this.leadBot();
    return [
      "<b>Talking to your teammates</b>",
      `• Just write: it goes to the teammate you last talked to${lead ? `, or ${escapeHtml(lead.name)} to start` : ""}.`,
      "• Start with a name to pick someone: <code>Rex: check the build</code>",
      "• Reply to any message here to continue that chat.",
      "• Send photos and files, and they get them.",
      "• Approve or deny with the buttons on approval requests.",
      "/team lists your teammates and what they're doing.",
    ].join("\n");
  }

  private async teamText(): Promise<string> {
    const rows = await this.ctx.db
      .select({ id: bots.id, name: bots.name, role: bots.role })
      .from(bots)
      .where(isNull(bots.archivedAt))
      .orderBy(asc(bots.createdAt));
    if (rows.length === 0) return "You have no teammates yet. Create one in open-bot.";
    const active = await this.ctx.db
      .select({ botId: runs.botId, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, ["queued", "starting", "running", "waiting"]));
    return rows
      .map((bot) => {
        const run = active.find((r) => r.botId === bot.id);
        const state = !run ? "free" : run.status === "waiting" ? "waiting for you" : "working";
        return `<b>${escapeHtml(bot.name)}</b>, ${escapeHtml(bot.role)} · ${state}`;
      })
      .join("\n");
  }

  private async leadBot() {
    const [lead] = await this.ctx.db
      .select({ id: bots.id, name: bots.name })
      .from(bots)
      .where(isNull(bots.archivedAt))
      .orderBy(desc(bots.isPrimary), asc(bots.createdAt))
      .limit(1);
    return lead ?? null;
  }

  private async directChat(botId: string): Promise<string | null> {
    const [chat] = await this.ctx.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.botId, botId), eq(chats.kind, "direct"), isNull(chats.archivedAt)))
      .orderBy(desc(chats.lastActivityAt))
      .limit(1);
    return chat?.id ?? null;
  }

  /** Which chat a message from Telegram goes to, and its text without the teammate's name. */
  private async route(
    lastChatId: string | null,
    message: TgMessage,
    text: string,
  ): Promise<{ chatId: string; text: string } | null> {
    if (message.reply_to_message) {
      const [mapped] = await this.ctx.db
        .select({ chatId: telegramMessages.chatId })
        .from(telegramMessages)
        .innerJoin(chats, eq(chats.id, telegramMessages.chatId))
        .where(
          and(
            eq(telegramMessages.telegramChatId, String(message.chat.id)),
            eq(telegramMessages.telegramMessageId, message.reply_to_message.message_id),
            isNull(chats.archivedAt),
          ),
        );
      if (mapped?.chatId) return { chatId: mapped.chatId, text };
    }
    const team = await this.ctx.db
      .select({ id: bots.id, name: bots.name })
      .from(bots)
      .where(isNull(bots.archivedAt));
    // "Rex: …", "Rex, …" or "@Rex …" picks a teammate. Longer names first, so "Al Bot" beats "Al".
    for (const bot of [...team].sort((a, b) => b.name.length - a.name.length)) {
      const name = bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^@?${name}(?:[:,]\\s*|\\s+)([\\s\\S]*)$`, "i").exec(text);
      if (match) {
        const chatId = await this.directChat(bot.id);
        if (chatId) return { chatId, text: match[1]!.trim() };
      }
    }
    if (lastChatId) {
      const [chat] = await this.ctx.db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, lastChatId), isNull(chats.archivedAt)));
      if (chat) return { chatId: chat.id, text };
    }
    const lead = await this.leadBot();
    const chatId = lead ? await this.directChat(lead.id) : null;
    return chatId ? { chatId, text } : null;
  }

  private async receive(lastChatId: string | null, message: TgMessage, text: string) {
    const telegramChatId = String(message.chat.id);
    const target = await this.route(lastChatId, message, text);
    if (!target) {
      await this.send(telegramChatId, "You have no teammates yet. Create one in open-bot first.");
      return;
    }

    const attachments: Attachment[] = [];
    try {
      const photo = message.photo?.at(-1);
      if (photo) {
        if ((photo.file_size ?? 0) > MAX_FILE_BYTES) throw new TelegramError("too large");
        const file = await this.download(photo.file_id);
        const name = `photo-${message.message_id}.jpg`;
        const saved = await saveUpload(this.ctx, name, file.dataBase64);
        attachments.push({ name, path: saved.path, mime: "image/jpeg", size: saved.size });
      }
      if (message.document) {
        if ((message.document.file_size ?? 0) > MAX_FILE_BYTES)
          throw new TelegramError("too large");
        const file = await this.download(message.document.file_id);
        const name = message.document.file_name ?? `file-${message.message_id}`;
        const saved = await saveUpload(this.ctx, name, file.dataBase64);
        attachments.push({
          name,
          path: saved.path,
          mime: message.document.mime_type ?? "application/octet-stream",
          size: saved.size,
        });
      }
    } catch (error) {
      await this.send(
        telegramChatId,
        error instanceof TelegramError && error.message === "too large"
          ? "Telegram only lets bots download files up to 20 MB. Upload bigger ones in open-bot."
          : `Couldn't get that file: ${escapeHtml(errorMessage(error))}`,
        { replyTo: message.message_id },
      );
      return;
    }
    if (!target.text && attachments.length === 0) {
      await this.send(telegramChatId, "Write something after the teammate's name.", {
        replyTo: message.message_id,
      });
      return;
    }

    const [row] = await this.ctx.db
      .insert(messages)
      .values({
        chatId: target.chatId,
        role: "user",
        text: target.text || "(See the attached files.)",
        attachments,
        via: "telegram",
      })
      .returning({ id: messages.id });
    await this.ctx.db
      .insert(telegramMessages)
      .values({
        telegramChatId,
        telegramMessageId: message.message_id,
        chatId: target.chatId,
        messageId: row!.id,
      })
      .onConflictDoNothing();
    await this.ctx.db.update(telegram).set({ lastChatId: target.chatId }).where(eq(telegram.id, 1));
    // A reaction says it arrived; the reply comes when the teammate finishes.
    await this.call("setMessageReaction", {
      chat_id: telegramChatId,
      message_id: message.message_id,
      reaction: [{ type: "emoji", emoji: "👀" }],
    }).catch(() => {});
    await this.executor.dispatchMessage(row!.id);
  }

  private async onButton(query: NonNullable<TgUpdate["callback_query"]>) {
    const chatId = await this.linkedChat();
    const answer = (text: string) =>
      this.call("answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => {});
    if (!chatId || String(query.from.id) !== chatId) {
      await answer("This isn't linked to your open-bot.");
      return;
    }
    const match = /^ap:([0-9a-f-]{36}):(y|n)$/.exec(query.data ?? "");
    if (!match) {
      await answer("That button doesn't do anything anymore.");
      return;
    }
    const decision = match[2] === "y" ? "approved" : "denied";
    const decided = await this.approvalService.decide(match[1]!, decision);
    const [row] = await this.ctx.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, match[1]!));
    await answer(decided ? (decision === "approved" ? "Approved" : "Denied") : "Already decided");
    if (query.message)
      await this.markDecided(String(query.message.chat.id), query.message.message_id, row?.status);
  }

  /** Replace an approval's buttons with how it was decided. */
  private async markDecided(chatId: string, messageId: number, status: string | undefined) {
    const label =
      status === "approved" ? "✅ Approved" : status === "denied" ? "🚫 Denied" : "⌛ Expired";
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
    }).catch(() => {});
  }

  /* -------------------------------------------------------------- Sending */

  private appLink(path: string): string {
    return `${this.ctx.env.APP_URL.replace(/\/+$/, "")}${path}`;
  }

  private async onNotification(event: NotificationEvent) {
    if (!this.token) return;
    const telegramChatId = await this.linkedChat();
    if (!telegramChatId) return;

    // Replies to what you sent from Telegram go back as replies there.
    if ((event.kind === "run_finished" || event.kind === "run_failed") && event.runId) {
      const origin = await this.telegramOrigin(event.runId);
      const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, event.runId));
      if (!run) return;
      const automation =
        run.trigger === "schedule" || run.trigger === "watch" || run.trigger === "webhook";
      // Runs you started in the app stay in the app.
      if (!origin && !automation && event.kind === "run_finished") return;
      const [bot] = await this.ctx.db
        .select({ name: bots.name })
        .from(bots)
        .where(eq(bots.id, run.botId));
      const name = escapeHtml(bot?.name ?? "Your teammate");
      const body =
        event.kind === "run_failed"
          ? `⚠️ <b>${name} couldn't finish.</b>\n${escapeHtml(event.body)}`
          : `<b>${origin ? name : escapeHtml(event.title)}</b>\n${telegramHtml(run.finalText ?? "Done.")}`;
      const ids = await this.send(telegramChatId, body, { replyTo: origin?.telegramMessageId });
      await this.remember(telegramChatId, ids, { chatId: run.chatId });
      return;
    }

    if (event.kind === "approval" && event.approvalId) {
      const [approval] = await this.ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, event.approvalId));
      if (!approval || approval.status !== "pending") return;
      const detail = approval.detail.trim();
      const html = [
        `🛡 <b>${escapeHtml(event.title)}</b>`,
        escapeHtml(approval.title),
        detail ? `<blockquote expandable>${escapeHtml(detail.slice(0, 3000))}</blockquote>` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const ids = await this.send(telegramChatId, html, {
        keyboard: [
          [
            { text: "Approve", callback_data: `ap:${approval.id}:y` },
            { text: "Deny", callback_data: `ap:${approval.id}:n` },
          ],
        ],
      });
      await this.remember(telegramChatId, ids, {
        chatId: approval.chatId,
        approvalId: approval.id,
      });
      return;
    }

    const icon =
      event.kind === "takeover_request" ? "🖐" : event.kind === "cap_reached" ? "💳" : "💬";
    const link =
      event.kind === "takeover_request" && event.botId
        ? this.appLink(`/computer?screen=${event.botId}`)
        : event.chatId
          ? this.appLink(`/chats/${event.chatId}`)
          : null;
    const html = [
      `${icon} <b>${escapeHtml(event.title)}</b>`,
      event.body ? escapeHtml(event.body) : null,
      link
        ? `<a href="${link.replace(/"/g, "&quot;")}">${event.kind === "takeover_request" ? "Open the screen" : "Open in open-bot"}</a>`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const ids = await this.send(telegramChatId, html);
    if (event.chatId) await this.remember(telegramChatId, ids, { chatId: event.chatId });
  }

  /** The Telegram message that started or steered a run, if any. */
  private async telegramOrigin(runId: string) {
    const [run] = await this.ctx.db
      .select({ messageId: runs.messageId })
      .from(runs)
      .where(eq(runs.id, runId));
    const [origin] = await this.ctx.db
      .select({ telegramMessageId: telegramMessages.telegramMessageId })
      .from(telegramMessages)
      .innerJoin(messages, eq(messages.id, telegramMessages.messageId))
      .where(
        and(
          eq(messages.via, "telegram"),
          or(
            run?.messageId ? eq(messages.id, run.messageId) : undefined,
            eq(messages.steeredRunId, runId),
          ),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return origin ?? null;
  }

  private async remember(
    telegramChatId: string,
    ids: number[],
    target: { chatId: string; approvalId?: string },
  ) {
    if (ids.length === 0) return;
    await this.ctx.db
      .insert(telegramMessages)
      .values(
        ids.map((id) => ({
          telegramChatId,
          telegramMessageId: id,
          chatId: target.chatId,
          approvalId: target.approvalId ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  /** When an approval is decided anywhere, its Telegram buttons show the decision. */
  private async approvalDecided(approvalId: string): Promise<void> {
    if (!this.token) return;
    const [approval] = await this.ctx.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    const sent = await this.ctx.db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.approvalId, approvalId));
    for (const message of sent)
      await this.markDecided(message.telegramChatId, message.telegramMessageId, approval?.status);
  }
}
