import type { ServerRequest } from "@open-bot/agent";
import type { ApprovalDecision, Autonomy, TimelineItem } from "@open-bot/domain";
import { describe, expect, it, vi } from "vitest";
import { onServerRequest, type RequestSession } from "./approvals";

/** What Codex 0.162.1 sent before a call of a connection's `echo` tool, as captured. */
const TOOL_APPROVAL = {
  method: "mcpServer/elicitation/request",
  id: 0,
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "probe",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "Echo text back",
      tool_params: { text: "hello" },
      tool_params_display: [{ name: "text", value: "hello", display_name: "text" }],
    },
    message: 'Allow the probe MCP server to run tool "echo"?',
    requestedSchema: { type: "object", properties: {} },
  },
} as ServerRequest;

/** The call Codex reports as started just before it asks. */
const RUNNING_CALL: TimelineItem = {
  id: "call_1",
  kind: "tool",
  status: "running",
  startedAt: "2026-11-19T00:00:00.000Z",
  name: "probe.echo",
  label: "Used echo",
  args: { text: "hello" },
};

type Session = RequestSession<Session>;

function session(autonomy: Autonomy, decision: ApprovalDecision | "pending" = "approved") {
  const requestActionApproval = vi.fn(async () => decision);
  const requestNativeApproval = vi.fn(async () => true);
  const s: Session = {
    teammate: { autonomy },
    items: new Map([[RUNNING_CALL.id, RUNNING_CALL]]),
    services: {
      tools: { handle: vi.fn() },
      requestNativeApproval,
      requestActionApproval,
    },
  };
  return { s, requestActionApproval, requestNativeApproval };
}

describe("a connection's tool call Codex asks about", () => {
  it("asks you, for that exact call, when the teammate asks before everything", async () => {
    const { s, requestActionApproval } = session("everything");

    expect(await onServerRequest(s, TOOL_APPROVAL)).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(requestActionApproval).toHaveBeenCalledWith(s, {
      title: "Use echo from the probe connection",
      subject: "Use echo from the probe connection",
      detail: "Echo text back\ntext: hello",
      itemId: "approval-call_1",
      operation: { tool: "mcp:probe.echo", arguments: { text: "hello" } },
    });
  });

  it("declines what you deny, and cancels what you haven't answered yet", async () => {
    expect(await onServerRequest(session("everything", "denied").s, TOOL_APPROVAL)).toMatchObject({
      action: "decline",
    });
    expect(await onServerRequest(session("everything", "pending").s, TOOL_APPROVAL)).toMatchObject({
      action: "cancel",
    });
  });

  it("runs without asking you when the teammate decides itself what needs approval", async () => {
    for (const autonomy of ["full", "risky"] as const) {
      const { s, requestActionApproval } = session(autonomy);
      expect(await onServerRequest(s, TOOL_APPROVAL)).toEqual({
        action: "accept",
        content: null,
        _meta: null,
      });
      expect(requestActionApproval).not.toHaveBeenCalled();
    }
  });

  it("names the tool from Codex's question when the call wasn't reported", async () => {
    const { s, requestActionApproval } = session("everything");
    s.items.clear();
    await onServerRequest(s, TOOL_APPROVAL);
    expect(requestActionApproval).toHaveBeenCalledWith(
      s,
      expect.objectContaining({
        subject: "Use echo from the probe connection",
        itemId: expect.stringMatching(/^approval-[0-9a-f-]{36}$/),
      }),
    );
  });
});

describe("an MCP server's own elicitation", () => {
  it("is declined without asking: a form to fill in or a link to open", async () => {
    const form = {
      method: "mcpServer/elicitation/request",
      id: 1,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "probe",
        mode: "form",
        _meta: null,
        message: "Which project?",
        requestedSchema: { type: "object", properties: { project: { type: "string" } } },
      },
    } as ServerRequest;
    const url = {
      method: "mcpServer/elicitation/request",
      id: 2,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "probe",
        mode: "url",
        _meta: { codex_approval_kind: "mcp_tool_call" },
        message: "Sign in",
        url: "https://example.test/sign-in",
        elicitationId: "e-1",
      },
    } as ServerRequest;
    for (const request of [form, url]) {
      const { s, requestActionApproval } = session("everything");
      expect(await onServerRequest(s, request)).toEqual({
        action: "decline",
        content: null,
        _meta: null,
      });
      expect(requestActionApproval).not.toHaveBeenCalled();
    }
  });
});
