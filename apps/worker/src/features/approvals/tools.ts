// request_approval: asking the user before a consequential action.
import { z } from "zod";
import { defineTool, text, type ToolDefinition, type ToolResponse } from "../../core/tool";
import type { RunSession } from "../../runs/session";
import type { ApprovalService } from "./service";

/** What the approval tools use. */
interface ApprovalToolDeps {
  approvals: Pick<ApprovalService, "requestAction">;
}

export const APPROVAL_TOOLS: ToolDefinition<z.ZodObject, ApprovalToolDeps>[] = [
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
];

async function requestApproval(
  deps: ApprovalToolDeps,
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
