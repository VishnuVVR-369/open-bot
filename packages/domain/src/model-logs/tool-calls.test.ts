import { describe, expect, it } from "vitest";
import { toolCallsOf } from "./tool-calls";

// Output items shaped like Codex 0.162.1's `ResponseItem` and what ChatGPT's Codex backend sends.
const OUTPUT = [
  {
    type: "reasoning",
    id: "rs_01",
    summary: [{ type: "summary_text", text: "Run a command" }],
    encrypted_content: "gAAA",
  },
  {
    // Code mode: the model writes JavaScript for the `exec` tool, which runs nested tools.
    type: "custom_tool_call",
    id: "ctc_0a1b",
    status: "completed",
    call_id: "call_74364e8a",
    name: "exec",
    input: 'const r = await tools.exec_command({cmd: "ls"}); text(r.output);',
  },
  {
    type: "function_call",
    id: "fc_08744",
    status: "completed",
    name: "send_message",
    arguments: '{"text":"hi"}',
    call_id: "call_ef71237",
  },
  {
    type: "function_call",
    name: "list_issues",
    namespace: "mcp__github__",
    arguments: "{}",
    call_id: "call_mcp1",
  },
  {
    type: "local_shell_call",
    id: "lsh_1",
    call_id: "call_shell",
    status: "completed",
    action: { type: "exec", command: ["bash", "-lc", "ls"] },
  },
  {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "weather" },
  },
  {
    type: "tool_search_call",
    call_id: "call_ts",
    execution: "client",
    arguments: { query: "calendar" },
  },
  { type: "image_generation_call", id: "ig_123", status: "completed", result: "iVBOR" },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Done." }],
  },
];

describe("toolCallsOf", () => {
  it("finds each kind of tool call, with what the model passed", () => {
    expect(toolCallsOf(OUTPUT)).toEqual([
      {
        position: 1,
        callId: "call_74364e8a",
        type: "custom_tool_call",
        name: "exec",
        namespace: null,
        arguments: OUTPUT[1]!.input,
      },
      {
        position: 2,
        callId: "call_ef71237",
        type: "function_call",
        name: "send_message",
        namespace: null,
        arguments: '{"text":"hi"}',
      },
      {
        position: 3,
        callId: "call_mcp1",
        type: "function_call",
        name: "list_issues",
        namespace: "mcp__github__",
        arguments: "{}",
      },
      {
        position: 4,
        callId: "call_shell",
        type: "local_shell_call",
        name: "local_shell",
        namespace: null,
        arguments: '{"type":"exec","command":["bash","-lc","ls"]}',
      },
      {
        // A web search has no call id; Codex names its item by the output item's id.
        position: 5,
        callId: "ws_1",
        type: "web_search_call",
        name: "web_search",
        namespace: null,
        arguments: '{"type":"search","query":"weather"}',
      },
      {
        position: 6,
        callId: "call_ts",
        type: "tool_search_call",
        name: "tool_search",
        namespace: null,
        arguments: '{"query":"calendar"}',
      },
      {
        position: 7,
        callId: "ig_123",
        type: "image_generation_call",
        name: "image_generation",
        namespace: null,
        arguments: null,
      },
    ]);
  });

  it("ignores anything that isn't a tool call", () => {
    expect(toolCallsOf([null, "x", { type: "message" }, { type: "function_call_output" }])).toEqual(
      [],
    );
  });
});
