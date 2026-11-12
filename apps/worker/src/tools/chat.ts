// Tools for the chat a teammate works in: its title, notifying the user, approvals and takeovers.
import { chatTitleText } from "@open-bot/domain";
import { z } from "zod";
import { publishApp } from "../context";
import type { RunSession } from "../runs/session";
import { titleChat } from "../services/chats";
import { createNotification } from "../services/notifications";
import {
  defineTool,
  text,
  type AnyTool,
  type ToolDeps,
  toolItem,
  type ToolResponse,
} from "./define";

export const CHAT_TOOLS: AnyTool[] = [
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
  defineTool({
    name: "request_approval",
    description:
      "Ask the user to approve a consequential action before you do it: sending a message or email, posting or publishing, buying or paying, deleting data, changing account settings or permissions. Waits for their answer, up to 10 minutes. Returns approved, denied, or pending (then end your turn; you'll get a message with the decision).",
    input: z.object({
      action: z
        .string()
        .trim()
        .min(1, "action is required")
        .max(120)
        .describe("What you want to do, as a short imperative, e.g. 'Send the reply to Dana'."),
      details: z
        .string()
        .trim()
        .max(4000)
        .describe("Exactly what will happen, including the full text you'll send."),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => requestApproval(deps, session, callId, args),
  }),
  defineTool({
    name: "request_takeover",
    description:
      "Ask the user to take control of your screen for a step only a human should do: entering a password, a 2FA code, a CAPTCHA, a passkey or a payment confirmation. Never ask for secrets in chat. Waits up to 10 minutes for them to hand control back, and returns their note. If it returns pending, end your turn; you'll get a message when they hand back.",
    input: z.object({
      reason: z
        .string()
        .trim()
        .min(1, "reason is required")
        .max(300)
        .describe("What you need them to do, e.g. 'Sign in to GitHub (the 2FA prompt is open)'."),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) =>
      requestTakeover(deps, session, callId, args.reason),
  }),
];

/**
 * Names an untitled direct chat after its topic. Quiet: no step in the chat, since the new
 * title shows in the chat list and header. Never replaces a title the user gave.
 */
async function setChatTitle(
  deps: ToolDeps,
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
  deps: ToolDeps,
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

async function requestApproval(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  { action, details }: { action: string; details: string },
): Promise<ToolResponse> {
  const decision = await deps.approvals.requestAction(session, {
    title: action,
    detail: details,
    itemId: callId,
  });
  switch (decision) {
    case "approved":
      return text("Approved. Go ahead.");
    case "denied":
      return text(
        "Denied. Don't do it. Ask the user what they'd like instead, or continue with other work.",
      );
    default:
      return text(
        "Still pending: the user hasn't answered yet. End your turn now and say you're waiting for approval; you'll get a message with the decision.",
      );
  }
}

async function requestTakeover(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  reason: string,
): Promise<ToolResponse> {
  const result = await deps.takeovers.requestFromBot(session, { reason, itemId: callId });
  if (result.status === "handed_back") {
    return text(
      `The user handed your screen back.${result.note ? ` Their note: "${result.note}"` : " They left no note."} Take a screenshot to see the current state, then continue.`,
    );
  }
  if (result.status === "dismissed") {
    return text(
      "The user dismissed the request. Don't use the desktop for this step; tell them what is blocked.",
    );
  }
  return text(
    "Still pending: the user hasn't taken over yet. End your turn and say what you need; you'll get a message when they hand your screen back.",
  );
}
