import "server-only";
import type { ApiInputs, MessageView } from "@open-bot/api";
import {
  bots,
  chatMembers,
  chats,
  messages,
  runs,
  uploads,
  LOCKS,
  lockUntilCommit,
  type Tx,
} from "@open-bot/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { publish } from "../publish";
import { worker } from "../worker";
import { toMessageView } from "../views";
import { ApiError } from "./errors";

type Inputs = ApiInputs["chats"];

export async function newDirectChat({ botId }: Inputs["newDirect"]): Promise<{ chatId: string }> {
  const [bot] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId));
  if (!bot) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
  const [chat] = await db
    .insert(chats)
    .values({ kind: "direct", title: bot.name, botId })
    .returning({ id: chats.id });
  await publish({ type: "chats" });
  return { chatId: chat!.id };
}

export async function createGroupChat({ title, botIds }: Inputs["createGroup"]) {
  const unique = [...new Set(botIds)];
  if (unique.length < 2) throw new ApiError("BAD_REQUEST", "Pick at least two teammates.");
  const found = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(inArray(bots.id, unique), isNull(bots.archivedAt)));
  if (found.length !== unique.length)
    throw new ApiError("NOT_FOUND", "One of those teammates no longer exists.");
  const chatId = await db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({ kind: "group", title, titled: true })
      .returning({ id: chats.id });
    await tx.insert(chatMembers).values(unique.map((botId) => ({ chatId: chat!.id, botId })));
    return chat!.id;
  });
  await publish({ type: "chats" });
  return { chatId };
}

async function updateChat(chatId: string, values: Partial<typeof chats.$inferInsert>) {
  const [chat] = await db
    .update(chats)
    .set(values)
    .where(eq(chats.id, chatId))
    .returning({ id: chats.id });
  if (!chat) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
}

export async function renameChat({ chatId, title }: Inputs["rename"]) {
  await updateChat(chatId, { title, titled: true });
  await publish({ type: "chats" });
  return { ok: true as const };
}

export async function archiveChat({ chatId }: Inputs["archive"]) {
  await updateChat(chatId, { archivedAt: new Date() });
  await publish({ type: "chats" });
  return { ok: true as const };
}

/** You've seen the chat: what teammates said in it isn't unread anymore, on any device. */
export async function markChatRead({ chatId }: Inputs["markRead"]) {
  const [before] = await db
    .select({
      readAt: chats.readAt,
      lastReply:
        sql<Date | null>`(select max(${runs.completedAt}) from ${runs} where ${runs.chatId} = ${chats.id} and ${runs.status} in ('completed', 'failed'))`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
    })
    .from(chats)
    .where(eq(chats.id, chatId));
  if (!before) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
  await updateChat(chatId, { readAt: new Date() });
  // Only lists that showed it as unread need to change.
  if (before.lastReply && before.lastReply > before.readAt) await publish({ type: "chats" });
  return { ok: true as const };
}

/** Attachments must be uploads that finished, so a teammate never gets half a file. */
async function checkAttachments(tx: Tx, attachments: Inputs["send"]["attachments"]) {
  if (attachments.length === 0) return;
  await lockUntilCommit(tx, ...attachments.map((attachment) => LOCKS.upload(attachment.path)));
  const rows = await tx
    .select()
    .from(uploads)
    .where(
      inArray(
        uploads.path,
        attachments.map((attachment) => attachment.path),
      ),
    );
  for (const attachment of attachments) {
    const upload = rows.find((row) => row.path === attachment.path);
    if (!upload || upload.status !== "complete")
      throw new ApiError(
        "BAD_REQUEST",
        `${attachment.name} didn't finish uploading. Attach it again.`,
      );
    if (upload.size !== attachment.size || upload.name !== attachment.name)
      throw new ApiError("BAD_REQUEST", `${attachment.name} doesn't match what was uploaded.`);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Save a message, then ask the worker to deliver it. Saving is what counts: if the worker can't
 * be reached, it delivers pending messages itself when it's back. A retry with the same client id
 * returns the saved message and asks for delivery again, which the worker makes safe.
 */
export async function sendMessage(input: Inputs["send"]): Promise<MessageView> {
  const text = input.text.trim();
  if (!text && input.attachments.length === 0)
    throw new ApiError("BAD_REQUEST", "Write a message first.");
  const values = {
    clientId: input.clientId,
    chatId: input.chatId,
    role: "user" as const,
    text: text || "(See the attached files.)",
    attachments: input.attachments,
    mentions: input.mentions,
  };

  const conflict = () =>
    new ApiError("CONFLICT", "That message id was already used for another message.");
  const same = (row: typeof messages.$inferSelect) =>
    row.chatId === values.chatId &&
    row.role === "user" &&
    row.text === values.text &&
    sameJson(row.attachments, values.attachments) &&
    sameJson(row.mentions, values.mentions);

  const row = await db.transaction(async (tx) => {
    // A retry: the message is saved already.
    let [row] = await tx.select().from(messages).where(eq(messages.clientId, input.clientId));
    if (row && !same(row)) throw conflict();
    if (!row) {
      const [chat] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, input.chatId));
      if (!chat) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
      await checkAttachments(tx, values.attachments);
      [row] = await tx
        .insert(messages)
        .values(values)
        .onConflictDoNothing({ target: messages.clientId })
        .returning();
      // The same send, arriving twice at once: the other one saved it.
      if (!row) {
        [row] = await tx.select().from(messages).where(eq(messages.clientId, input.clientId));
        if (!row || !same(row)) throw conflict();
      }
    }

    return row;
  });

  if (row.dispatchStatus === "pending") {
    await worker.messages.dispatch({ messageId: row.id }).catch((error: unknown) => {
      // Saved, so it isn't lost: the worker dispatches pending messages when it can.
      console.warn("dispatch deferred to the worker's reconciler", {
        messageId: row!.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return toMessageView(row);
}
