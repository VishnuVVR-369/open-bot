// Codex asks before a connection's (MCP server's) tool call with an MCP elicitation: a form with
// no fields whose `_meta` says it is a tool-call approval. Every other elicitation is a real form
// an MCP server wants filled in, which open-bot has no way to show you yet.
import type { v2 } from "@open-bot/agent";
import type { ApprovalDecision, Autonomy, TimelineItem } from "@open-bot/domain";
import { z } from "zod";

/** What Codex 0.162.1 puts in `_meta` when it asks before an MCP tool call. */
const toolCallMeta = z.object({
  codex_approval_kind: z.literal("mcp_tool_call"),
  tool_description: z.string().nullish(),
  tool_params: z.record(z.string(), z.unknown()).nullish(),
  tool_params_display: z
    .array(z.object({ name: z.string(), display_name: z.string().nullish(), value: z.unknown() }))
    .nullish(),
});

export interface McpToolApproval {
  /** The timeline item of the call, when Codex reported it started. */
  callId: string | null;
  server: string;
  tool: string | null;
  arguments: Record<string, unknown>;
  /** Codex's own question, like `Allow the probe MCP server to run tool "echo"?`. */
  message: string;
  description: string | null;
  params: { name: string; value: unknown }[];
}

/** The tool call Codex asks about, or null when the elicitation is anything else. */
export function mcpToolApproval(
  params: v2.McpServerElicitationRequestParams,
  items: ReadonlyMap<string, TimelineItem>,
): McpToolApproval | null {
  if (params.mode !== "form") return null;
  const meta = toolCallMeta.safeParse(params._meta);
  if (!meta.success) return null;
  const args = meta.data.tool_params ?? {};
  const call = runningCall(params.serverName, args, items);
  return {
    callId: call?.id ?? null,
    server: params.serverName,
    // `_meta` doesn't name the tool: the running call does, or failing that Codex's question.
    tool: call?.tool ?? /run tool "(.+)"\?$/.exec(params.message)?.[1] ?? null,
    arguments: args,
    message: params.message,
    description: meta.data.tool_description ?? null,
    params: (meta.data.tool_params_display ?? []).map((param) => ({
      name: param.display_name || param.name,
      value: param.value,
    })),
  };
}

/**
 * The call Codex asks about. It reports the call as started just before it asks, so it is the
 * call of that server still running with these arguments.
 */
function runningCall(
  server: string,
  args: Record<string, unknown>,
  items: ReadonlyMap<string, TimelineItem>,
): { id: string; tool: string } | null {
  const prefix = `${server}.`;
  const wanted = JSON.stringify(args);
  for (const item of [...items.values()].reverse())
    if (
      item.kind === "tool" &&
      item.status === "running" &&
      item.name.startsWith(prefix) &&
      JSON.stringify(item.args ?? {}) === wanted
    )
      return { id: item.id, tool: item.name.slice(prefix.length) };
  return null;
}

/** What you approve: the wording an "Always allow" rule matches, the card and the exact call. */
export function toolCallApprovalRequest(approval: McpToolApproval) {
  const tool = approval.tool ?? "a tool";
  // The wording leaves the arguments out, so one rule covers every call of the tool.
  const subject = `Use ${tool} from the ${approval.server} connection`;
  const params = approval.params.map(
    ({ name, value }) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return {
    title: subject,
    subject,
    detail: [approval.description, ...params].filter(Boolean).join("\n") || approval.message,
    // The approval belongs to this exact call: a late one lets the follow-up run repeat it once.
    operation: { tool: `mcp:${approval.server}.${tool}`, arguments: approval.arguments },
  };
}

/**
 * Whether you are asked: only a teammate that asks before every command asks before every
 * connection tool call too. The others decide themselves when to call request_approval first,
 * as their instructions say, the same as for commands.
 */
export function asksBeforeToolCalls(autonomy: Autonomy): boolean {
  return autonomy === "everything";
}

/**
 * Codex's answer for a decision. A pending one (you didn't answer in time) is "cancel", which
 * Codex reports as "user cancelled MCP tool call", unlike a denial's "user rejected".
 */
export function toolCallAnswer(
  decision: ApprovalDecision | "pending",
): v2.McpServerElicitationRequestResponse {
  const action = decision === "approved" ? "accept" : decision === "denied" ? "decline" : "cancel";
  return { action, content: null, _meta: null };
}
