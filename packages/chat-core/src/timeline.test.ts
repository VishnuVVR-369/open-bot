import type { TimelineItem } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import {
  currentActivity,
  isPinned,
  pendingRequest,
  replyText,
  turnParts,
  workDuration,
  workingText,
  workSummary,
} from "./timeline";
import { triggerLabel } from "./triggers";

const at = "2026-11-12T10:00:00.000Z";
const base = { status: "completed", startedAt: at } as const;

const reply = (id: string, text: string, phase: "final" | "commentary" = "final") =>
  ({ ...base, id, kind: "message", text, phase }) as TimelineItem;
const thinking = (id: string, text: string) =>
  ({ ...base, id, kind: "reasoning", text }) as TimelineItem;
const command = (id: string, script: string, status: "running" | "completed" = "completed") =>
  ({
    ...base,
    status,
    id,
    kind: "command",
    command: script,
    output: "",
    exitCode: 0,
  }) as TimelineItem;
const computer = (id: string, status: "running" | "completed" = "completed") =>
  ({
    ...base,
    status,
    id,
    kind: "computer",
    action: { action: "screenshot" },
  }) as TimelineItem;
const tool = (id: string, name: string, status: "running" | "completed" = "completed") =>
  ({ ...base, status, id, kind: "tool", name, label: `Used ${name}` }) as TimelineItem;
const approval = (
  id: string,
  decision: "pending" | "approved",
  title = "Pay",
  approvalKind = "purchase",
) => ({ ...base, id, kind: "approval", decision, title, approvalKind }) as TimelineItem;

describe("turnParts", () => {
  it("groups a stretch of computer actions into one part", () => {
    const { parts, steps } = turnParts([
      computer("c1"),
      computer("c2"),
      thinking("r1", "Looking"),
      computer("c3"),
    ]);
    expect(parts.map((part) => part.kind)).toEqual(["computer", "item", "computer"]);
    expect(parts[0]).toMatchObject({ kind: "computer", items: [{ id: "c1" }, { id: "c2" }] });
    expect(steps).toBe(3);
  });

  it("doesn't count pinned items or empty thinking as steps", () => {
    const { steps } = turnParts([thinking("r0", ""), command("x1", "ls"), reply("m1", "Done")]);
    expect(steps).toBe(1);
  });

  it("drops a step the pending approval right after it restates", () => {
    const items = [tool("t1", "start_purchase"), approval("a1", "pending")];
    expect(turnParts(items).parts.map((part) => part.id)).toEqual(["a1"]);
    // A finished tool that isn't one of the asking tools stays.
    const other = [tool("t2", "browse"), approval("a2", "pending")];
    expect(turnParts(other).parts.map((part) => part.id)).toEqual(["t2", "a2"]);
  });

  it("says an approved command once, marked as approved", () => {
    const items = [
      approval("a1", "approved", "rm -rf build", "command"),
      command("x1", "rm -rf build"),
    ];
    const { parts, approved } = turnParts(items);
    expect(parts.map((part) => part.id)).toEqual(["x1"]);
    expect([...approved]).toEqual(["x1"]);
  });
});

describe("a turn's words", () => {
  it("pins the reply and what needs you", () => {
    expect(isPinned(reply("m1", "Hi"))).toBe(true);
    expect(isPinned(reply("m2", "Hmm", "commentary"))).toBe(false);
    expect(isPinned(approval("a1", "pending"))).toBe(true);
    expect(isPinned(approval("a2", "approved"))).toBe(false);
  });

  it("copies only the final reply", () => {
    expect(replyText([reply("m0", "Let me look", "commentary"), reply("m1", " Found it ")])).toBe(
      "Found it",
    );
  });

  it("says what the teammate is doing from the latest step", () => {
    expect(currentActivity([thinking("r1", "x"), command("x1", "npm test\nnpm run build")])).toBe(
      "Running npm test",
    );
    expect(currentActivity([computer("c1")])).toBe("Using the computer");
    expect(currentActivity([reply("m1", "Let me check", "commentary")])).toBeNull();
    const timeline = (status: string, items: TimelineItem[] = []) =>
      ({ timeline: { status, items } }) as never;
    expect(workingText(timeline("queued"))).toBe("Up next");
    expect(workingText(timeline("starting"))).toBe("Getting ready");
    expect(workingText(timeline("running", [tool("t1", "browse", "running")]))).toBe("Used browse");
    expect(workingText(timeline("running"))).toBe("Working");
    const searching = timeline("running", [tool("t1", "browse", "running")]);
    expect(workingText(searching, { activity: false })).toBe("Working");
  });

  it("times the work until it finished or stopped to wait on you", () => {
    const run = (status: string, completedAt: string | null, items: TimelineItem[] = []) =>
      ({ startedAt: at, completedAt, timeline: { status, items } }) as never;
    expect(workDuration(run("completed", "2026-11-12T10:03:05.000Z"))).toBe(185_000);
    const asked = { ...approval("a1", "pending"), startedAt: "2026-11-12T10:00:21.000Z" };
    expect(workDuration(run("waiting", null, [asked as TimelineItem]))).toBe(21_000);
    expect(pendingRequest([asked as TimelineItem])?.id).toBe("a1");
    expect(workDuration(run("running", null))).toBeNull();
    expect(workSummary(185_000, 2)).toBe("Worked for 3m 5s · 2 steps");
    expect(workSummary(null, 1)).toBe("1 step");
  });
});

describe("triggerLabel", () => {
  const run = (trigger: string, extra: object = {}) =>
    ({ trigger, scheduleTitle: null, triggerTitle: null, fromTeammateId: null, ...extra }) as never;
  const teammates = [{ id: "t1", name: "Rex" }];

  it("names automations by their title, and marks them", () => {
    expect(triggerLabel(run("schedule", { scheduleTitle: "Morning news" }), [])).toEqual({
      kind: "schedule",
      text: "Morning news",
      automation: true,
    });
    expect(triggerLabel(run("webhook"), [])?.text).toBe("Webhook");
  });

  it("says which teammate a handoff came from", () => {
    expect(triggerLabel(run("answer", { fromTeammateId: "t1" }), teammates)).toEqual({
      kind: "answer",
      text: "Rex answered",
      automation: false,
    });
    expect(triggerLabel(run("handoff", { fromTeammateId: "gone" }), teammates)?.text).toBe(
      "Handed over",
    );
  });

  it("needs no label for your own message", () => {
    expect(triggerLabel(run("user"), teammates)).toBeNull();
    expect(triggerLabel(run("takeover_ended"), teammates)).toBeNull();
  });
});
