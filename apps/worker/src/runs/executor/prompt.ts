// Builds the prompt of a run: the time, group chat context, memory, Always allow rules, the
// request and its attachments.
import {
  teammates as teammateRows,
  chatMembers,
  chats,
  messages,
  ownerTimeZone,
  runs,
} from "@open-bot/db";
import { and, asc, desc, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import type { Context } from "../../context";
import type { Run } from "../../core/db-types";
import type { ApprovalService } from "../../features/approvals";
import type { MemoryCoordinator } from "../../features/memory";
import { allowedList } from "../../instructions";
import type { RunSession } from "../session";

/** What building a prompt reads from the executor. */
export interface PromptExecutor {
  readonly ctx: Context;
  readonly memory: MemoryCoordinator;
  readonly approvals: ApprovalService;
}

export async function buildPrompt(executor: PromptExecutor, session: RunSession): Promise<string> {
  const { run, chat, bot } = session;
  const timeZone = await ownerTimeZone(executor.ctx.db);
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  const lines = [`[Now: ${now} (${timeZone})]`];

  if (chat.kind === "group") {
    const members = await executor.ctx.db
      .select({ id: teammateRows.id, name: teammateRows.name, role: teammateRows.role })
      .from(chatMembers)
      .innerJoin(teammateRows, eq(teammateRows.id, chatMembers.teammateId))
      .where(and(eq(chatMembers.chatId, chat.id), isNull(teammateRows.archivedAt)));
    const teammates = members.filter((member) => member.id !== bot.id);
    lines.push(
      `[Group chat "${chat.title}". Teammates here: ${teammates.map((t) => `${t.name} (${t.role})`).join(", ") || "none"}. Use handoff_to_bot when a teammate's job fits a request better.]`,
    );
    const recent = await recentGroupContext(executor, run, bot.id);
    if (recent) lines.push(`[Since you last spoke in this chat:]\n${recent}`);
  }

  // Read now, not from the run's start: an earlier turn may have titled it since.
  if (chat.kind === "direct" && !session.isHelper && !(await titled(executor, chat.id)))
    lines.push(
      "[This chat has no title yet. Once its topic is clear, call set_chat_title with a short title, then carry on. Wait while it's only a greeting.]",
    );

  const memory = await executor.memory.context(session);
  if (memory) lines.push(memory);

  // Rules you add mid-conversation reach a thread that already read its AGENTS.md.
  const allowed = allowedList(await executor.approvals.rulesFor(bot.id));
  if (allowed)
    lines.push(`[The user always allows these without asking for approval:]\n${allowed}`);

  lines.push(run.prompt);
  if (run.attachments.length) {
    lines.push(
      `Attached files:\n${run.attachments.map((file) => `- ${file.path} (${file.mime}, ${Math.ceil(file.size / 1024)} KB)`).join("\n")}`,
    );
  }
  return lines.join("\n\n");
}

async function titled(executor: PromptExecutor, chatId: string): Promise<boolean> {
  const [row] = await executor.ctx.db
    .select({ titled: chats.titled })
    .from(chats)
    .where(eq(chats.id, chatId));
  return row?.titled ?? true;
}

/** What the user and other bots said in a group chat since this bot's last run. */
async function recentGroupContext(
  executor: PromptExecutor,
  run: Run,
  botId: string,
): Promise<string | null> {
  const [last] = await executor.ctx.db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.chatId, run.chatId), eq(runs.teammateId, botId), ne(runs.id, run.id)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  const since = last?.createdAt ?? new Date(0);
  const [userMessages, botReplies] = await Promise.all([
    executor.ctx.db
      .select({ text: messages.text, createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, run.chatId),
          eq(messages.role, "user"),
          gt(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(10),
    executor.ctx.db
      .select({ text: runs.finalText, createdAt: runs.completedAt, name: teammateRows.name })
      .from(runs)
      .innerJoin(teammateRows, eq(teammateRows.id, runs.teammateId))
      .where(
        and(
          eq(runs.chatId, run.chatId),
          ne(runs.teammateId, botId),
          isNotNull(runs.finalText),
          gt(runs.createdAt, since),
        ),
      )
      .orderBy(asc(runs.completedAt))
      .limit(10),
  ]);
  const entries = [
    ...userMessages
      .filter((message) => message.id !== run.messageId)
      .map((message) => ({ at: message.createdAt, line: `User: ${message.text}` })),
    ...botReplies.map((reply) => ({
      at: reply.createdAt ?? new Date(),
      line: `${reply.name}: ${reply.text}`,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!entries.length) return null;
  return entries.map((entry) => entry.line.slice(0, 1500)).join("\n");
}
