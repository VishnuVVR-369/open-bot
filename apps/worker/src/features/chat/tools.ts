// Tools for the chat a teammate works in: its title, and notifying the user.
import { chatTitleText } from "@open-bot/domain";
import { z } from "zod";
import { publishApp, type Context } from "../../context";
import {
  defineTool,
  text,
  toolItem,
  type ToolDefinition,
  type ToolResponse,
} from "../../core/tool";
import type { RunSession } from "../../runs/session";
import { createNotification } from "../../services/notifications";
import { titleChat } from "./service";

/** What the chat tools use. */
interface ChatToolDeps {
  ctx: Pick<Context, "db" | "pool" | "events">;
}

export const CHAT_TOOLS: ToolDefinition<z.ZodObject, ChatToolDeps>[] = [
  defineTool({
    name: "set_chat_title",
    description:
      "Name this chat after what it's about, once you know: 2 to 6 words, like 'Fix the login redirect' or 'Lisbon trip ideas'. Only for a direct chat that has no title yet; the user's own title is never replaced. No quotes, emoji or trailing period.",
    input: z.object({
      title: z.string().min(1, "title is required").max(60),
    }),
    helpers: "allowed",
    handle: ({ session, args }, deps) => setChatTitle(deps, session, args.title),
  }),
  defineTool({
    name: "notify_user",
    description:
      "Send the user a notification (desktop notification and the app's inbox). Use it for results they asked to hear about, or when you're blocked. Keep it short.",
    input: z.object({
      title: z.string().min(1, "title is required").max(80),
      message: z.string().min(1, "message is required").max(500),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) => notifyUser(deps, session, callId, args, raw),
  }),
];

/**
 * Names an untitled direct chat after its topic. Quiet: no step in the chat, since the new
 * title shows in the chat list and header. Never replaces a title the user gave.
 */
async function setChatTitle(
  deps: ChatToolDeps,
  session: RunSession,
  rawTitle: string,
): Promise<ToolResponse> {
  if (session.chat.kind !== "direct")
    return text("Only a direct chat can be titled this way; this one keeps its name.", false);
  const title = chatTitleText(rawTitle);
  if (!title) return text("title is required", false);
  if (!(await titleChat(deps.ctx.db, session.chat.id, title)))
    return text("This chat already has a title, so it stays as it is.");
  await publishApp(deps.ctx, { type: "chats" });
  return text(`Titled this chat "${title}".`);
}

async function notifyUser(
  deps: ChatToolDeps,
  session: RunSession,
  callId: string,
  { title, message }: { title: string; message: string },
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const item = toolItem(callId, "notify_user", `Notified you: ${title}`, raw, session.now());
  await createNotification(deps.ctx, {
    kind: "bot_message",
    title: `${session.bot.name}: ${title}`,
    body: message,
    botId: session.bot.id,
    chatId: session.chat.id,
    runId: session.run.id,
  });
  session.putItem({ ...item, status: "completed", completedAt: session.now(), result: message });
  return text("Notification sent.");
}
