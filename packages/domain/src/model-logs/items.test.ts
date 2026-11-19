import { describe, expect, it } from "vitest";
import { describeItem, instructionsText, offeredTools, rebuildInput } from "./items";

const json = (value: unknown) => JSON.stringify(value);

describe("describeItem", () => {
  it("labels messages by role, with their text parts", () => {
    expect(
      describeItem({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Book the flight" },
          { type: "input_image", image_url: "data:..." },
        ],
      }),
    ).toMatchObject({ kind: "user", label: "User", text: "Book the flight\n\n[image]" });
    expect(
      describeItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      }),
    ).toMatchObject({ kind: "assistant", label: "Assistant", text: "Done." });
    expect(describeItem({ type: "message", role: "developer", content: "Be brief" })).toMatchObject(
      { kind: "system", label: "Developer", text: "Be brief" },
    );
  });

  it("labels tool calls with their name and laid-out arguments", () => {
    expect(
      describeItem({
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: '{"cmd":"ls"}',
      }),
    ).toEqual({
      kind: "tool_call",
      label: "Tool call: exec_command",
      text: '{\n  "cmd": "ls"\n}',
      callId: "call_1",
      type: "function_call",
    });
    expect(
      describeItem({ type: "custom_tool_call", name: "exec", call_id: "c2", input: "await x()" }),
    ).toMatchObject({ kind: "tool_call", label: "Tool call: exec", text: "await x()" });
    expect(
      describeItem({ type: "mcp_call", name: "search", server_label: "github", arguments: "{}" }),
    ).toMatchObject({ label: "Tool call: github.search" });
  });

  it("labels tool outputs, as a string or as content parts", () => {
    expect(
      describeItem({ type: "function_call_output", call_id: "call_1", output: "a.txt" }),
    ).toMatchObject({ kind: "tool_output", label: "Tool output", text: "a.txt", callId: "call_1" });
    expect(
      describeItem({
        type: "custom_tool_call_output",
        call_id: "c2",
        output: [{ type: "input_text", text: "Script completed" }],
      }),
    ).toMatchObject({ kind: "tool_output", text: "Script completed" });
  });

  it("shows a reasoning summary, and says when only encrypted reasoning was kept", () => {
    expect(
      describeItem({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checking the dates" }],
        encrypted_content: "gAAA",
      }),
    ).toMatchObject({ kind: "reasoning", label: "Reasoning summary", text: "Checking the dates" });
    expect(
      describeItem({ type: "reasoning", summary: [], encrypted_content: "gAAA" }),
    ).toMatchObject({ text: "Encrypted reasoning, no summary." });
  });

  it("never fails on shapes it doesn't know", () => {
    expect(describeItem("embed this")).toMatchObject({ kind: "other", label: "Text" });
    expect(describeItem({ type: "something_new", x: 1 })).toMatchObject({
      kind: "other",
      label: "something_new",
    });
    expect(describeItem(null)).toMatchObject({ kind: "other" });
  });
});

describe("rebuildInput", () => {
  const user = json({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  });
  const call = json({ type: "function_call", name: "ls", call_id: "c1", arguments: "{}" });
  const output = json({ type: "function_call_output", call_id: "c1", output: "a" });

  it("puts the items back in order, whatever order they were read in", () => {
    const { items, missing } = rebuildInput(
      [
        { position: 2, content: output },
        { position: 0, content: user },
        { position: 1, content: call },
      ],
      null,
    );
    expect(items.map((item) => [item.position, item.kind, item.sent])).toEqual([
      [0, "user", true],
      [1, "tool_call", true],
      [2, "tool_output", true],
    ]);
    expect(items[1]!.json).toBe(call);
    expect(missing).toEqual([]);
  });

  it("marks the items a WebSocket message carried over rather than sent", () => {
    const { items } = rebuildInput(
      [
        { position: 0, content: user },
        { position: 1, content: call },
        { position: 2, content: output },
      ],
      2,
    );
    expect(items.map((item) => item.sent)).toEqual([false, false, true]);
  });

  it("reports holes and items whose blob is gone, without making them up", () => {
    const { items, missing } = rebuildInput(
      [
        { position: 0, content: user },
        { position: 2, content: null },
        { position: 4, content: output },
      ],
      null,
    );
    expect(items.map((item) => item.position)).toEqual([0, 4]);
    expect(missing).toEqual([1, 2, 3]);
  });

  it("keeps an unreadable item as text", () => {
    const { items } = rebuildInput([{ position: 0, content: "{not json" }], null);
    expect(items[0]).toMatchObject({ label: "Unreadable item", text: "{not json" });
  });
});

describe("offeredTools and instructionsText", () => {
  it("lists tools by name, with their definition", () => {
    const tools = offeredTools(
      json([
        { type: "function", name: "exec_command", description: "Run a command" },
        { type: "web_search" },
      ]),
    );
    expect(tools.map(({ name, type, description }) => ({ name, type, description }))).toEqual([
      { name: "exec_command", type: "function", description: "Run a command" },
      { name: "web_search", type: "web_search", description: null },
    ]);
    expect(offeredTools(null)).toEqual([]);
    expect(offeredTools("{broken")).toEqual([]);
  });

  it("reads instructions stored as a JSON string", () => {
    expect(instructionsText(json("You are Kit."))).toBe("You are Kit.");
    expect(instructionsText(null)).toBeNull();
  });
});
