import { toMessageView, type MessageView, type SendMessageInput } from "@open-bot/api";
import {
  bots as teammates, // vocabulary: allow
  chatMembers,
  chats,
  LOCKS,
  lockUntilCommit,
  messages,
  runs,
  uploads,
  type Queryable,
  type Tx,
} from "@open-bot/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { errorMessage } from "../logger";

/**
 * Chats, who is in them, and the messages you send: this module owns those tables (see
 * packages/db/src/owners.ts). Other worker code changes them through the functions here, which
 * take the caller's transaction where the change belongs with one of its own.
 */

/** A chat change that can't be made as asked; the message says why. */
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Message = typeof messages.$inferSelect;
type NewChat = Pick<typeof chats.$inferInsert, "kind" | "title" | "botId" | "titled">;

/** Save a chat. Tell the app (`chats`) once the caller's transaction commits. */
export async function addChat(db: Queryable, chat: NewChat): Promise<string> {
  const [row] = await db.insert(chats).values(chat).returning({ id: chats.id });
  return row!.id;
}

/**
 * A teammate's own chat of this kind (where its emails arrive, or its routines run), made the
 * first time it's needed.
 */
export async function teammateChat(
  ctx: Context,
  teammateId: string,
  kind: "inbox" | "scheduled",
): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.botId, teammateId), eq(chats.kind, kind), isNull(chats.archivedAt)));
  if (existing) return existing.id;
  const title = kind === "inbox" ? "Email" : "Scheduled";
  const id = await addChat(ctx.db, { kind, title, botId: teammateId });
  await publishApp(ctx, { type: "chats" });
  return id;
}

/** A renamed teammate's direct chats follow its name, unless they have a title of their own. */
export async function renameDirectChats(tx: Tx, teammateId: string, name: string) {
  await tx
    .update(chats)
    .set({ title: name })
    .where(and(eq(chats.botId, teammateId), eq(chats.kind, "direct"), eq(chats.titled, false)));
}

/** Archive every chat of an archived teammate. */
export async function archiveChatsOf(tx: Tx, teammateId: string, at: Date) {
  await tx
    .update(chats)
    .set({ archivedAt: at })
    .where(and(eq(chats.botId, teammateId), isNull(chats.archivedAt)));
}

/** Something happened in the chat, so it moves up the list. */
export async function touchChat(db: Queryable, chatId: string) {
  await db.update(chats).set({ lastActivityAt: new Date() }).where(eq(chats.id, chatId));
}

/** Title a chat that has no title of its own yet. False when it has one. */
export async function titleChat(db: Queryable, chatId: string, title: string): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({ title, titled: true })
    .where(and(eq(chats.id, chatId), eq(chats.titled, false)))
    .returning({ id: chats.id });
  return rows.length > 0;
}

/**
 * Save a message you wrote, once per `clientId`: a message with that id already saved comes back
 * as it is, for the caller to compare. The caller dispatches it.
 */
export async function saveUserMessage(
  db: Queryable,
  values: Omit<typeof messages.$inferInsert, "role" | "id" | "dispatchStatus">,
): Promise<{ message: Message; saved: boolean }> {
  const [row] = await db
    .insert(messages)
    .values({ ...values, role: "user" })
    .onConflictDoNothing({ target: messages.clientId })
    .returning();
  if (row) return { message: row, saved: true };
  const [existing] = values.clientId
    ? await db.select().from(messages).where(eq(messages.clientId, values.clientId))
    : [];
  if (!existing) throw new Error("The message was neither saved nor found.");
  return { message: existing, saved: false };
}

/** The message joined a running turn. */
export async function markSteered(db: Queryable, messageId: string, runId: string) {
  await db.update(messages).set({ steeredRunId: runId }).where(eq(messages.id, messageId));
}

/** The message went to every teammate it's for. True the first time, when it was still pending. */
export async function markDispatched(db: Queryable, messageId: string): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ dispatchStatus: "dispatched" })
    .where(and(eq(messages.id, messageId), eq(messages.dispatchStatus, "pending")))
    .returning({ id: messages.id });
  return rows.length > 0;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Attachments must be uploads that finished, so a teammate never gets half a file. */
async function checkAttachments(tx: Tx, attachments: SendMessageInput["attachments"]) {
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
      throw new ChatError(400, `${attachment.name} didn't finish uploading. Attach it again.`);
    if (upload.size !== attachment.size || upload.name !== attachment.name)
      throw new ChatError(400, `${attachment.name} doesn't match what was uploaded.`);
  }
}

/** A reused message id. */
export const REUSED_ID = "That message id was already used for another message.";

export class ChatService {
  constructor(
    private readonly ctx: Context,
    /** Deliver a saved message to the teammates it's for (the executor). Safe to call again. */
    private readonly dispatch: (messageId: string) => Promise<void>,
  ) {}

  async newDirect(teammateId: string): Promise<{ chatId: string }> {
    const [teammate] = await this.ctx.db
      .select({ name: teammates.name })
      .from(teammates)
      .where(eq(teammates.id, teammateId));
    if (!teammate) throw new ChatError(404, "That teammate no longer exists.");
    const chatId = await addChat(this.ctx.db, {
      kind: "direct",
      title: teammate.name,
      botId: teammateId,
    });
    await publishApp(this.ctx, { type: "chats" });
    return { chatId };
  }

  async createGroup(title: string, teammateIds: string[]): Promise<{ chatId: string }> {
    const unique = [...new Set(teammateIds)];
    if (unique.length < 2) throw new ChatError(400, "Pick at least two teammates.");
    const found = await this.ctx.db
      .select({ id: teammates.id })
      .from(teammates)
      .where(and(inArray(teammates.id, unique), isNull(teammates.archivedAt)));
    if (found.length !== unique.length)
      throw new ChatError(404, "One of those teammates no longer exists.");
    const chatId = await this.ctx.db.transaction(async (tx) => {
      const id = await addChat(tx, { kind: "group", title, titled: true });
      await tx.insert(chatMembers).values(unique.map((botId) => ({ chatId: id, botId })));
      return id;
    });
    await publishApp(this.ctx, { type: "chats" });
    return { chatId };
  }

  private async change(chatId: string, values: Partial<typeof chats.$inferInsert>) {
    const [chat] = await this.ctx.db
      .update(chats)
      .set(values)
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id });
    if (!chat) throw new ChatError(404, "That chat no longer exists.");
  }

  async rename(chatId: string, title: string) {
    await this.change(chatId, { title, titled: true });
    await publishApp(this.ctx, { type: "chats" });
  }

  async archive(chatId: string) {
    await this.change(chatId, { archivedAt: new Date() });
    await publishApp(this.ctx, { type: "chats" });
  }

  /** You've seen the chat: what teammates said in it isn't unread anymore, on any device. */
  async markRead(chatId: string) {
    const [before] = await this.ctx.db
      .select({
        readAt: chats.readAt,
        lastReply:
          sql<Date | null>`(select max(${runs.completedAt}) from ${runs} where ${runs.chatId} = ${chats.id} and ${runs.status} in ('completed', 'failed'))`.mapWith(
            (value: string | Date | null) => (value === null ? null : new Date(value)),
          ),
      })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!before) throw new ChatError(404, "That chat no longer exists.");
    await this.change(chatId, { readAt: new Date() });
    // Only lists that showed it as unread need to change.
    if (before.lastReply && before.lastReply > before.readAt)
      await publishApp(this.ctx, { type: "chats" });
  }

  /**
   * Save a message you sent, then deliver it. Saving is what counts: if delivery fails, the
   * executor delivers pending messages itself. A retry with the same client id returns the saved
   * message and delivers it again, which is safe.
   */
  async send(input: SendMessageInput): Promise<MessageView> {
    const text = input.text.trim();
    if (!text && input.attachments.length === 0) throw new ChatError(400, "Write a message first.");
    const values = {
      clientId: input.clientId,
      chatId: input.chatId,
      text: text || "(See the attached files.)",
      attachments: input.attachments,
      mentions: input.mentions,
    };
    const same = (row: Message) =>
      row.chatId === values.chatId &&
      row.role === "user" &&
      row.text === values.text &&
      sameJson(row.attachments, values.attachments) &&
      sameJson(row.mentions, values.mentions);

    const row = await this.ctx.db.transaction(async (tx) => {
      // A retry: the message is saved already.
      const [saved] = await tx.select().from(messages).where(eq(messages.clientId, input.clientId));
      if (saved) {
        if (!same(saved)) throw new ChatError(409, REUSED_ID);
        return saved;
      }
      const [chat] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, input.chatId));
      if (!chat) throw new ChatError(404, "That chat no longer exists.");
      await checkAttachments(tx, values.attachments);
      // The same send, arriving twice at once: the other one saved it.
      const { message } = await saveUserMessage(tx, values);
      if (!same(message)) throw new ChatError(409, REUSED_ID);
      return message;
    });

    if (row.dispatchStatus === "pending") await this.deliver(row.id);
    return toMessageView(row);
  }

  /** Deliver a saved message; a failure is retried by the executor, which finds it pending. */
  async deliver(messageId: string) {
    await this.dispatch(messageId).catch((error: unknown) =>
      this.ctx.log.warn("dispatch deferred to the reconciler", {
        messageId,
        error: errorMessage(error),
      }),
    );
  }
}
