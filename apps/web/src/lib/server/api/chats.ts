import "server-only";
import type { ApiInputs, MessageView } from "@open-bot/api";
import { bots, chats, messages } from "@open-bot/db";
import { eq } from "drizzle-orm";
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
  await publish("chats");
  return { chatId: chat!.id };
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

  // A retry: the message is saved already.
  let [row] = await db.select().from(messages).where(eq(messages.clientId, input.clientId));
  if (row && !same(row)) throw conflict();
  if (!row) {
    const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, input.chatId));
    if (!chat) throw new ApiError("NOT_FOUND", "That chat no longer exists.");
    [row] = await db
      .insert(messages)
      .values(values)
      .onConflictDoNothing({ target: messages.clientId })
      .returning();
    // The same send, arriving twice at once: the other one saved it.
    if (!row) {
      [row] = await db.select().from(messages).where(eq(messages.clientId, input.clientId));
      if (!row || !same(row)) throw conflict();
    }
  }

  if (row.dispatchStatus === "pending") {
    await worker("POST", `/internal/messages/${row.id}/dispatch`).catch((error: unknown) => {
      // Saved, so it isn't lost: the worker dispatches pending messages when it can.
      console.warn("dispatch deferred to the worker's reconciler", {
        messageId: row!.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return toMessageView(row);
}
