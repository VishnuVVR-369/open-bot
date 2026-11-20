// Messages from Telegram: linking with a code, commands, and routing everything else to the
// teammate's chat, with photos and files.
import { createHash } from "node:crypto";
import {
  bots,
  chats,
  messages,
  runs,
  telegram,
  telegramMessages,
  type Attachment,
} from "@open-bot/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { publishApp } from "../../context";
import { errorMessage } from "../../logger";
import type { RunExecutor } from "../../runs/executor";
import { UploadError, type UploadService } from "../uploads";
import { mainChat, saveUserMessage } from "../chat";
import {
  call,
  download,
  escapeHtml,
  send,
  TelegramError,
  type TelegramClient,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "./api";
import { onButton, type ApprovalButtons } from "./approvals";

/** Telegram's limit on files a bot can download. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** What handling a message needs from the service. */
export interface TelegramInbox extends ApprovalButtons {
  readonly executor: RunExecutor;
  readonly uploads: Pick<UploadService, "save">;
}

function displayName(user: TgUser | undefined): string {
  if (!user) return "you";
  return user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
}

export async function handle(service: TelegramInbox, update: TgUpdate) {
  if (update.callback_query) return onButton(service, update.callback_query);
  const message = update.message;
  if (!message || message.chat.type !== "private") return;
  const chatId = String(message.chat.id);
  const text = (message.text ?? message.caption ?? "").trim();
  const [row] = await service.ctx.db.select().from(telegram).where(eq(telegram.id, 1));

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start?.[1]) {
    const valid =
      row?.linkCode &&
      row.linkCodeExpiresAt &&
      row.linkCodeExpiresAt.getTime() > Date.now() &&
      start[1].toUpperCase() === row.linkCode;
    // Linked already, as when this update is retried after linking: say so again.
    if (!valid && row?.chatId === chatId) {
      await send(service, chatId, `✅ <b>Linked.</b>\n\n${await helpText(service)}`);
      return;
    }
    if (!valid) {
      await send(
        service,
        chatId,
        "That link code isn't valid anymore. Get a new one in open-bot's Settings.",
      );
      return;
    }
    await service.ctx.db
      .update(telegram)
      .set({
        chatId,
        linkedName: displayName(message.from),
        linkCode: null,
        linkCodeExpiresAt: null,
      })
      .where(eq(telegram.id, 1));
    await publishApp(service.ctx, { type: "telegram" });
    await send(
      service,
      chatId,
      `✅ <b>Linked.</b> You'll get approvals and updates from your teammates here.\n\n${await helpText(service)}`,
    );
    return;
  }
  // Everyone but the linked chat is turned away, without saying anything about your data.
  if (!row?.chatId || row.chatId !== chatId) {
    await send(
      service,
      chatId,
      "This is a private assistant. Link it from open-bot's Settings to use it.",
    );
    return;
  }
  if (/^\/(start|help)(@\w+)?$/.test(text)) {
    await send(service, chatId, await helpText(service));
    return;
  }
  if (/^\/team(@\w+)?$/.test(text)) {
    await send(service, chatId, await teamText(service));
    return;
  }
  await receive(service, row.lastChatId, message, text);
}

export async function helpText(service: TelegramClient): Promise<string> {
  const lead = await leadBot(service);
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

export async function teamText(service: TelegramClient): Promise<string> {
  const rows = await service.ctx.db
    .select({ id: bots.id, name: bots.name, role: bots.role })
    .from(bots)
    .where(isNull(bots.archivedAt))
    .orderBy(asc(bots.createdAt));
  if (rows.length === 0) return "You have no teammates yet. Create one in open-bot.";
  const active = await service.ctx.db
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

export async function leadBot(service: TelegramClient) {
  const [lead] = await service.ctx.db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(isNull(bots.archivedAt))
    .orderBy(desc(bots.isLead), asc(bots.createdAt))
    .limit(1);
  return lead ?? null;
}

/** Which chat a message from Telegram goes to, and its text without the teammate's name. */
export async function route(
  service: TelegramClient,
  lastChatId: string | null,
  message: TgMessage,
  text: string,
): Promise<{ chatId: string; text: string } | null> {
  if (message.reply_to_message) {
    const [mapped] = await service.ctx.db
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
  const team = await service.ctx.db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(isNull(bots.archivedAt));
  // "Rex: …", "Rex, …" or "@Rex …" picks a teammate. Longer names first, so "Al Bot" beats "Al".
  for (const bot of [...team].sort((a, b) => b.name.length - a.name.length)) {
    const name = bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^@?${name}(?:[:,]\\s*|\\s+)([\\s\\S]*)$`, "i").exec(text);
    if (match) {
      return { chatId: await mainChat(service.ctx, bot.id), text: match[1]!.trim() };
    }
  }
  if (lastChatId) {
    const [chat] = await service.ctx.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, lastChatId), isNull(chats.archivedAt)));
    if (chat) return { chatId: chat.id, text };
  }
  const lead = await leadBot(service);
  return lead ? { chatId: await mainChat(service.ctx, lead.id), text } : null;
}

/**
 * What to tell you about a file that can't be had however often it's tried: over Telegram's 20 MB, one
 * Telegram refuses or doesn't share, or one uploads refuse. Null for anything worth retrying.
 */
function fileRefused(error: unknown): string | null {
  if (
    error instanceof TelegramError &&
    (error.message === "too large" || /file is too big/i.test(error.message))
  )
    return "Telegram only lets bots download files up to 20 MB. Upload bigger ones in open-bot.";
  if (error instanceof TelegramError && error.code === 400)
    return `Couldn't get that file: ${escapeHtml(error.message)}`;
  if (error instanceof UploadError && error.status < 500)
    return `Couldn't save that file: ${escapeHtml(error.message)}`;
  return null;
}

/**
 * The id a Telegram message is saved under, the same every time it's handled: a retried update
 * finds the message it saved before instead of saving it again. Telegram numbers messages per chat
 * and per token owner, so the account id (the token's first part) is part of it.
 */
export function telegramClientId(token: string, message: TgMessage): string {
  const account = token.split(":")[0];
  const hash = createHash("sha256")
    .update(`telegram:${account}:${message.chat.id}:${message.message_id}`)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function receive(
  service: TelegramInbox,
  lastChatId: string | null,
  message: TgMessage,
  text: string,
) {
  const telegramChatId = String(message.chat.id);
  const clientId = telegramClientId(service.token ?? "", message);
  // Handled before, and this is a retry: finish what didn't happen then, without saving it twice.
  const [saved] = await service.ctx.db
    .select()
    .from(messages)
    .where(eq(messages.clientId, clientId));
  if (saved) {
    await delivered(service, message, saved);
    return;
  }
  const target = await route(service, lastChatId, message, text);
  if (!target) {
    await send(service, telegramChatId, "You have no teammates yet. Create one in open-bot first.");
    return;
  }

  const attachments: Attachment[] = [];
  try {
    const photo = message.photo?.at(-1);
    if (photo) {
      if ((photo.file_size ?? 0) > MAX_FILE_BYTES) throw new TelegramError("too large");
      attachments.push(
        await service.uploads.save({
          name: `photo-${message.message_id}.jpg`,
          mime: "image/jpeg",
          data: await download(service, photo.file_id),
        }),
      );
    }
    if (message.document) {
      if ((message.document.file_size ?? 0) > MAX_FILE_BYTES) throw new TelegramError("too large");
      attachments.push(
        await service.uploads.save({
          name: message.document.file_name ?? `file-${message.message_id}`,
          mime: message.document.mime_type ?? "application/octet-stream",
          data: await download(service, message.document.file_id),
        }),
      );
    }
  } catch (error) {
    // Telegram busy or unreachable, or the computer or the database failing: the update fails, so
    // it's tried again, and you hear nothing until then.
    const refused = fileRefused(error);
    if (!refused) throw error;
    await send(service, telegramChatId, refused, { replyTo: message.message_id });
    return;
  }
  if (!target.text && attachments.length === 0) {
    await send(service, telegramChatId, "Write something after the teammate's name.", {
      replyTo: message.message_id,
    });
    return;
  }

  const { message: row } = await saveUserMessage(service.ctx.db, {
    chatId: target.chatId,
    clientId,
    text: target.text || "(See the attached files.)",
    attachments,
    via: "telegram",
  });
  await delivered(service, message, row);
}

/**
 * After a Telegram message is saved: remember where it went, so a reply there continues that chat,
 * react so you know it arrived, and hand it to its teammates. Each step is safe to repeat.
 */
async function delivered(
  service: TelegramInbox,
  message: TgMessage,
  row: { id: string; chatId: string },
) {
  const telegramChatId = String(message.chat.id);
  await service.ctx.db
    .insert(telegramMessages)
    .values({
      telegramChatId,
      telegramMessageId: message.message_id,
      chatId: row.chatId,
      messageId: row.id,
    })
    .onConflictDoNothing();
  await service.ctx.db.update(telegram).set({ lastChatId: row.chatId }).where(eq(telegram.id, 1));
  // A reaction says it arrived; the reply comes when the teammate finishes.
  await call(service, "setMessageReaction", {
    chat_id: telegramChatId,
    message_id: message.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch((error: unknown) =>
    service.ctx.log.warn("couldn't react to a Telegram message", { error: errorMessage(error) }),
  );
  await service.executor.dispatchMessage(row.id);
}
