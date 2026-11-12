// The teammate's own email: send and list.

import { z } from "zod";
import type { RunSession } from "../runs/session";
import { EmailError } from "../services/email";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolDeps,
  toolItem,
  type ToolResponse,
} from "./define";

export const EMAIL_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "send_email",
    description:
      "Send an email from your own address (it's in your instructions). To answer an email you got, set reply_to to its email id, so it threads. Unless you work fully on your own, the user approves each email before it goes, and it goes out by itself once they do; this is the approval, so don't also call request_approval. Write it ready to send.",
    input: z.object({
      to: z.array(z.string().describe("An email address.")).min(1).max(10),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000).describe("Plain text."),
      reply_to: z.string().describe("The email id you're answering, if any.").optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => sendEmail(deps, session, callId, args),
  }),
  defineTool({
    name: "list_emails",
    description: "List the emails you got and sent recently, with their email ids.",
    input: z.object({}),
    helpers: "allowed",
    handle: async ({ session }, deps) => text(await deps.email.describe(session.bot.id)),
  }),
];

const emailArgs = z.object({
  to: z.preprocess(
    (value) => (typeof value === "string" ? value.split(",") : value),
    z
      .array(z.string().trim().email("That isn't an email address."))
      .min(1)
      .max(10, "Send to 10 people at most."),
  ),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  reply_to: z.string().uuid("No email with that id.").optional(),
});

async function sendEmail(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const parsed = emailArgs.safeParse(args);
  if (!parsed.success)
    return text(parsed.error.issues.map((issue) => issue.message).join("; "), false);
  const { to, subject, body } = parsed.data;
  const startedAt = session.now();
  const item = toolItem(callId, "send_email", `Email to ${to.join(", ")}`, args, startedAt);
  try {
    const email = await deps.email.send(session, {
      to,
      subject,
      body,
      replyTo: parsed.data.reply_to ?? null,
      itemId: callId,
    });
    if (email.status === "sent") {
      session.putItem({
        ...item,
        label: `Emailed ${to.join(", ")}`,
        status: "completed",
        completedAt: session.now(),
        result: subject,
      });
      return text(`Sent (email id ${email.id}).`);
    }
    session.putItem({
      ...item,
      label: `Email to ${to.join(", ")} waits for you`,
      result: subject,
    });
    return text(
      `It's waiting for the user's approval (email id ${email.id}), and goes out by itself the moment they approve. Don't send it again. End your turn and say it's ready for their approval.`,
    );
  } catch (error) {
    if (!(error instanceof EmailError)) throw error;
    session.putItem({
      ...item,
      label: "Couldn't send an email",
      status: "failed",
      completedAt: session.now(),
      error: error.message,
    });
    return text(error.message, false);
  }
}
