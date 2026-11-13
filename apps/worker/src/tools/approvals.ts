// Asking the user: approving a consequential action, and taking over the screen for a step only a
// human should do. They move with the approvals and takeovers features.
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { defineTool, text, type AnyTool, type ToolDeps, type ToolResponse } from "./define";

export const APPROVAL_TOOLS: AnyTool[] = [
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
