// request_takeover: asking the user to take over the screen for a step only a human should do.
// It moves with the takeovers feature.
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { defineTool, text, type AnyTool, type ToolDeps, type ToolResponse } from "./define";

export const TAKEOVER_TOOLS: AnyTool[] = [
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
