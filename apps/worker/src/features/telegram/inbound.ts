// Messages from Telegram: linking with a code, commands, and routing everything else to the
// teammate's chat, with photos and files.
import { bots, chats, runs, telegram, telegramMessages, type Attachment } from "@open-bot/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { publishApp } from "../../context";
import { errorMessage } from "../../logger";
import type { RunExecutor } from "../../runs/executor";
import type { UploadService } from "../uploads";
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
    .orderBy(desc(bots.isPrimary), asc(bots.createdAt))
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

export async function receive(
  service: TelegramInbox,
  lastChatId: string | null,
  message: TgMessage,
  text: string,
) {
  const telegramChatId = String(message.chat.id);
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
    await send(
      service,
      telegramChatId,
      error instanceof TelegramError && error.message === "too large"
        ? "Telegram only lets bots download files up to 20 MB. Upload bigger ones in open-bot."
        : `Couldn't get that file: ${escapeHtml(errorMessage(error))}`,
      { replyTo: message.message_id },
    );
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
    text: target.text || "(See the attached files.)",
    attachments,
    via: "telegram",
  });
  await service.ctx.db
    .insert(telegramMessages)
    .values({
      telegramChatId,
      telegramMessageId: message.message_id,
      chatId: target.chatId,
      messageId: row.id,
    })
    .onConflictDoNothing();
  await service.ctx.db
    .update(telegram)
    .set({ lastChatId: target.chatId })
    .where(eq(telegram.id, 1));
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
