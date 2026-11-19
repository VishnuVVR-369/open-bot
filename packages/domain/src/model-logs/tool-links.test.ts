import { describe, expect, it } from "vitest";
import {
  codeModeCells,
  type LinkCall,
  type LinkRequest,
  linkToolItems,
  TRANSIT_SLACK_MS,
  toolOutputsOf,
} from "./tool-links";

const t0 = Date.parse("2026-11-17T10:00:00Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000);
const exec = (callId: string): LinkCall => ({
  callId,
  type: "custom_tool_call",
  name: "exec",
  arguments: "await tools.exec_command({cmd: 'ls'});",
});
const wait = (callId: string, cellId: string): LinkCall => ({
  callId,
  type: "function_call",
  name: "wait",
  arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 1000 }),
});
const request = (
  id: string,
  startedAt: number,
  firstByteAt: number,
  calls: LinkCall[],
  outputs: [string, string][] = [],
): LinkRequest => ({
  id,
  startedAt: at(startedAt),
  firstByteAt: at(firstByteAt),
  calls,
  outputs: outputs.map(([callId, text]) => ({ callId, text })),
});
const item = (itemId: string, seconds: number, type = "commandExecution") => ({
  itemId,
  type,
  at: at(seconds),
});
const DONE = "Script completed\nWall time 0.4 seconds\nOutput:\n";

describe("linkToolItems", () => {
  it("links a direct call exactly, by its call id", () => {
    const requests = [
      request("r1", 0, 1, [
        { callId: "call_ls", type: "function_call", name: "exec_command", arguments: "{}" },
      ]),
    ];
    expect(linkToolItems(requests, [item("call_ls", 2)])).toEqual([
      { itemId: "call_ls", type: "commandExecution", match: "exact", callIds: ["call_ls"] },
    ]);
  });

  it("links a nested item that starts while its response is still streaming", () => {
    // Codex starts the cell when the call's output item is done, before the response ends, so
    // the nested command starts between the first byte (1s) and the end (5s) of the response.
    const requests = [
      request("r1", 0, 1, [exec("call_a")]),
      request("r2", 6, 7, [], [["call_a", DONE]]),
    ];
    expect(linkToolItems(requests, [item("exec-1", 2)])).toEqual([
      { itemId: "exec-1", type: "commandExecution", match: "only_candidate", callIds: ["call_a"] },
    ]);
  });

  it("keeps a yielded cell a candidate across later requests until a wait says it ended", () => {
    const requests = [
      request("r1", 0, 1, [exec("call_a")]),
      // The cell yielded: the model got its first output and went on while it kept running.
      request("r2", 4, 5, [wait("call_w1", "7")], [["call_a", "Script running with cell ID 7"]]),
      request(
        "r3",
        20,
        21,
        [exec("call_b")],
        [
          ["call_a", "Script running with cell ID 7"],
          ["call_w1", DONE],
        ],
      ),
      request("r4", 30, 31, [], [["call_b", DONE]]),
    ];
    expect(codeModeCells(requests)).toEqual([
      {
        callId: "call_a",
        requestId: "r1",
        cellId: "7",
        from: at(1),
        until: new Date(at(20).getTime() + TRANSIT_SLACK_MS),
      },
      {
        callId: "call_b",
        requestId: "r3",
        cellId: null,
        from: at(21),
        until: new Date(at(30).getTime() + TRANSIT_SLACK_MS),
      },
    ]);
    const links = linkToolItems(requests, [
      // After the yield and after the next request: still the yielded cell's.
      item("exec-late", 12, "dynamicToolCall"),
      // Once the second cell started streaming, both could have been running.
      item("exec-overlap", 21.5, "mcpToolCall"),
      // Past the yielded cell's end and slack: only the second.
      item("exec-b", 25, "fileChange"),
    ]);
    expect(links.map(({ itemId, match, callIds }) => [itemId, match, callIds])).toEqual([
      ["exec-late", "only_candidate", ["call_a"]],
      ["exec-overlap", "ambiguous", ["call_a", "call_b"]],
      ["exec-b", "only_candidate", ["call_b"]],
    ]);
  });

  it("calls an item ambiguous when one response made several exec calls", () => {
    const requests = [
      request("r1", 0, 1, [exec("call_a"), exec("call_b")]),
      request(
        "r2",
        6,
        7,
        [],
        [
          ["call_a", DONE],
          ["call_b", DONE],
        ],
      ),
    ];
    expect(linkToolItems(requests, [item("exec-1", 3)])).toEqual([
      {
        itemId: "exec-1",
        type: "commandExecution",
        match: "ambiguous",
        callIds: ["call_a", "call_b"],
      },
    ]);
  });

  it("links nothing to a cell before its response streamed or after it ended", () => {
    const requests = [
      request("r1", 0, 2, [exec("call_a")]),
      request("r2", 6, 7, [], [["call_a", "Script failed\nWall time 0.1 seconds\nOutput:\n"]]),
    ];
    const links = linkToolItems(requests, [
      item("exec-early", 1),
      item("exec-after", 6 + TRANSIT_SLACK_MS / 1000 + 1),
      { itemId: "msg_1", type: "agentMessage", at: at(3) },
    ]);
    expect(links.map((link) => link.match)).toEqual(["none", "none"]);
  });

  it("leaves a cell open when its output has no status line", () => {
    // An error with no status line (here, a failure after the cell started) says nothing about
    // whether the cell is still running.
    const requests = [
      request("r1", 0, 1, [exec("call_a")]),
      request("r2", 3, 4, [], [["call_a", "failed to read the cell's first output"]]),
    ];
    expect(codeModeCells(requests)[0]!.until).toBeNull();
  });

  it("keeps a yielded cell open after a wait whose arguments didn't parse", () => {
    const badWait: LinkCall = {
      callId: "call_w1",
      type: "function_call",
      name: "wait",
      arguments: JSON.stringify({ cell_id: "7", yield_time_ms: -1 }),
    };
    const requests = [
      request("r1", 0, 1, [exec("call_a")]),
      request("r2", 4, 5, [badWait], [["call_a", "Script running with cell ID 7"]]),
      // Codex answers the bad `wait` with a plain error, no status line: the cell runs on.
      request(
        "r3",
        8,
        9,
        [wait("call_w2", "7")],
        [
          ["call_a", "Script running with cell ID 7"],
          ["call_w1", "failed to parse function arguments: invalid value: integer `-1`"],
        ],
      ),
      request(
        "r4",
        20,
        21,
        [],
        [
          ["call_a", "Script running with cell ID 7"],
          ["call_w1", "failed to parse function arguments: invalid value: integer `-1`"],
          ["call_w2", "Script terminated\nWall time 12.0 seconds\nOutput:\n"],
        ],
      ),
    ];
    expect(codeModeCells(requests)[0]).toMatchObject({
      cellId: "7",
      until: new Date(at(20).getTime() + TRANSIT_SLACK_MS),
    });
    const links = linkToolItems(requests, [item("exec-late", 15)]);
    expect(links.map(({ match, callIds }) => [match, callIds])).toEqual([
      ["only_candidate", ["call_a"]],
    ]);
  });

  it("reads only an exact status line as the end of a cell", () => {
    const requests = [
      request("r1", 0, 1, [exec("call_a")]),
      // Text that merely mentions a status is not one.
      request("r2", 3, 4, [], [["call_a", "Error: Script completed too early?"]]),
    ];
    expect(codeModeCells(requests)[0]!.until).toBeNull();
    const ended = [
      request("r1", 0, 1, [exec("call_a")]),
      request("r2", 3, 4, [], [["call_a", "Script failed  \nWall time 0.1 seconds"]]),
    ];
    expect(codeModeCells(ended)[0]!.until).toEqual(new Date(at(3).getTime() + TRANSIT_SLACK_MS));
  });
});

describe("toolOutputsOf", () => {
  it("reads function and custom tool outputs, as text or content parts", () => {
    expect(
      toolOutputsOf([
        { type: "message", role: "user", content: [] },
        { type: "function_call_output", call_id: "call_w", output: DONE },
        {
          type: "custom_tool_call_output",
          call_id: "call_a",
          output: [
            { type: "input_text", text: "Script running with cell ID 3\nWall time 10.0 seconds" },
            { type: "input_text", text: "partial" },
          ],
        },
      ]),
    ).toEqual([
      { callId: "call_w", text: DONE },
      { callId: "call_a", text: "Script running with cell ID 3\nWall time 10.0 seconds" },
    ]);
  });
});
