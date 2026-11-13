import type { TimelineItem } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import {
  commandStep,
  fileChangeSummary,
  handBackText,
  reasoningSummary,
  takeoverTitle,
  toolSummary,
  webSearchSummary,
} from "./step-text";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;
const command = (fields: Partial<Item<"command">>) =>
  ({
    kind: "command",
    command: "pnpm test",
    status: "completed",
    exitCode: 0,
    output: "",
    ...fields,
  }) as Item<"command">;
const fileChange = (changes: { path: string; change: string; diff?: string }[]) =>
  ({ kind: "file_change", status: "completed", changes }) as unknown as Item<"file_change">;

describe("step text", () => {
  it("sums up a thought by its first line, without bold marks", () => {
    expect(reasoningSummary("\n**Checking the calendar**\nThen the mail")).toBe(
      "Checking the calendar",
    );
    expect(reasoningSummary("  \n ")).toBe("Thinking");
  });

  it("says a command failed and with which exit code, and that you approved it", () => {
    expect(commandStep(command({}), false)).toEqual({
      command: "pnpm test",
      failed: false,
      summary: "pnpm test",
    });
    expect(commandStep(command({ exitCode: 1 }), true)).toEqual({
      command: "pnpm test",
      failed: true,
      summary: "pnpm test  · exit 1  · you approved",
    });
    // Still running: not failed yet, even with a nonzero exit code, and the summary keeps it.
    expect(commandStep(command({ status: "running", exitCode: 1 }), true)).toEqual({
      command: "pnpm test",
      failed: false,
      summary: "pnpm test  · exit 1  · you approved",
    });
    expect(commandStep(command({ status: "failed", exitCode: null }), false)).toMatchObject({
      failed: true,
      summary: "pnpm test",
    });
  });

  it("says what a file change did, to which files, and its size when it is one file", () => {
    expect(
      fileChangeSummary(fileChange([{ path: "/home/a/src/x.ts", change: "add", diff: "+a\n+b" }])),
    ).toBe("Created src/x.ts  +2 −0");
    expect(
      fileChangeSummary(
        fileChange([
          { path: "/a/b/c.md", change: "delete" },
          { path: "d.md", change: "delete" },
        ]),
      ),
    ).toBe("Deleted b/c.md, d.md");
    expect(
      fileChangeSummary(
        fileChange([
          { path: "x/y.ts", change: "update" },
          { path: "z.ts", change: "add" },
        ]),
      ),
    ).toBe("Edited x/y.ts, z.ts");
  });

  it("joins a tool's label, result and error", () => {
    const tool = (fields: object) =>
      ({ kind: "tool", label: "Read mail", result: "3 new", ...fields }) as Item<"tool">;
    expect(toolSummary(tool({ status: "completed", error: "ignored" }))).toBe("Read mail · 3 new");
    expect(toolSummary(tool({ status: "failed", result: null, error: "No access" }))).toBe(
      "Read mail · No access",
    );
  });

  it("words web searches, takeovers and screens handed back", () => {
    expect(webSearchSummary("lisbon hotels")).toBe("Searched the web for “lisbon hotels”");
    expect(webSearchSummary(null)).toBe("Searched the web");
    expect(takeoverTitle("pending", "Iris")).toBe("Iris needs you to take over");
    expect(takeoverTitle("taken", "Iris")).toBe("You're in control of the screen");
    expect(takeoverTitle("handed_back", "Iris")).toBe("You handed the screen back");
    expect(takeoverTitle("dismissed", "Iris")).toBe("Dismissed");
    expect(handBackText("Logged in")).toBe("You handed the screen back: “Logged in”");
    expect(handBackText("")).toBe("You handed the screen back");
  });
});
