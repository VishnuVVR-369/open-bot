import { describe, expect, it } from "vitest";
import { currentActivity } from "./activity";
import type { TimelineItem } from "./timeline";

const at = "2026-11-22T10:00:00.000Z";
const command = (script: string) =>
  ({
    id: "c1",
    kind: "command",
    status: "running",
    startedAt: at,
    command: script,
    cwd: "/",
    output: "",
    exitCode: null,
    durationMs: null,
  }) as TimelineItem;

describe("currentActivity", () => {
  it("says a command's first line, or only its program", () => {
    const items = [command("/bin/bash -lc 'npm test --token=abc\nnpm run build'")];
    expect(currentActivity(items)).toBe("Running npm test --token=abc");
    expect(currentActivity(items, { command: "program" })).toBe("Running npm");
    expect(currentActivity([command("  ")], { command: "program" })).toBe("Running a command");
  });

  it("looks past steps that say nothing to the latest one that does", () => {
    const commentary = {
      id: "m1",
      kind: "message",
      status: "completed",
      startedAt: at,
      text: "Let me check",
      phase: "commentary",
    } as TimelineItem;
    const tool = {
      id: "t1",
      kind: "tool",
      status: "running",
      startedAt: at,
      name: "browse",
      label: "Opened example.com",
      args: {},
    } as TimelineItem;
    expect(currentActivity([tool, commentary])).toBeNull();
    const plan = { id: "p1", kind: "plan", status: "running", startedAt: at, steps: [] };
    expect(currentActivity([tool, plan as TimelineItem])).toBe("Opened example.com");
  });
});
