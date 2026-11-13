import "server-only";
import { chatMembers, chats, messages, runs } from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, desc, eq, inArray, isNotNull, isNull, max, ne } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { ChatSummary } from "@/lib/types";
import { plainText } from "@/lib/utils";

/** Your chats, newest first. `previews` adds what was said last in each, for lists. */
export async function listChats({ helpers = false, previews: withPreviews = true } = {}): Promise<
  ChatSummary[]
> {
  const rows = await db
    .select()
    .from(chats)
    // A swarm helper's chat shows inside its teammate's chat, not in your list.
    .where(and(isNull(chats.archivedAt), helpers ? undefined : ne(chats.kind, "helper")))
    .orderBy(desc(chats.lastActivityAt));
  const members = await db.select().from(chatMembers);
  const activeChats = await db
    .selectDistinct({ chatId: runs.chatId })
    .from(runs)
    .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]));
  const activeSet = new Set(activeChats.map((row) => row.chatId));
  // When a teammate last finished replying in each chat, for unread.
  const replies = await db
    .select({ chatId: runs.chatId, at: max(runs.completedAt) })
    .from(runs)
    .where(inArray(runs.status, ["completed", "failed"]))
    .groupBy(runs.chatId);
  const lastReply = new Map(replies.map((row) => [row.chatId, row.at]));
  const previews = withPreviews ? await chatPreviews() : new Map();
  return rows.map((chat) => ({
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    botId: chat.botId,
    main: chat.main,
    memberIds:
      chat.kind === "group"
        ? members.filter((member) => member.chatId === chat.id).map((member) => member.botId)
        : chat.botId
          ? [chat.botId]
          : [],
    lastActivityAt: chat.lastActivityAt.toISOString(),
    active: activeSet.has(chat.id),
    unread: (lastReply.get(chat.id)?.getTime() ?? 0) > chat.readAt.getTime(),
    preview: previews.get(chat.id) ?? null,
  }));
}

/** How long a chat's preview gets: more than a list row shows, so each app can cut it to fit. */
const PREVIEW_LENGTH = 160;

/** The latest thing said in each chat: your last message or a teammate's last reply. */
async function chatPreviews(): Promise<Map<string, NonNullable<ChatSummary["preview"]>>> {
  const [sent, replied] = await Promise.all([
    db
      .selectDistinctOn([messages.chatId], {
        chatId: messages.chatId,
        text: messages.text,
        attachments: messages.attachments,
        at: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.role, "user"))
      .orderBy(messages.chatId, desc(messages.createdAt)),
    db
      .selectDistinctOn([runs.chatId], {
        chatId: runs.chatId,
        botId: runs.botId,
        text: runs.finalText,
        at: runs.createdAt,
        completedAt: runs.completedAt,
      })
      .from(runs)
      .where(isNotNull(runs.finalText))
      .orderBy(runs.chatId, desc(runs.createdAt)),
  ]);
  const previews = new Map<string, { text: string; botId: string | null; at: Date }>();
  for (const message of sent) {
    const text = plainText(message.text) || message.attachments[0]?.name || "";
    if (text) previews.set(message.chatId, { text, botId: null, at: message.at });
  }
  for (const reply of replied) {
    const text = plainText(reply.text ?? "");
    const at = reply.completedAt ?? reply.at;
    const mine = previews.get(reply.chatId);
    if (text && (!mine || at >= mine.at))
      previews.set(reply.chatId, { text, botId: reply.botId, at });
  }
  return new Map(
    [...previews].map(([chatId, { text, botId }]) => [
      chatId,
      { text: text.slice(0, PREVIEW_LENGTH), botId },
    ]),
  );
}
