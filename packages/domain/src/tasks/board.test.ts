import { describe, expect, it } from "vitest";
import {
  boardColumns,
  daysUntil,
  dueLabel,
  dueState,
  endPosition,
  filterCounts,
  formatDay,
  stepPosition,
  taskBlocker,
  type BlockerFacts,
  type BoardTask,
} from "./board";

const task = (overrides: Partial<BoardTask> & { id: string }): BoardTask => ({
  status: "todo",
  position: 1,
  ownerTeammateId: null,
  dueOn: null,
  chatId: null,
  completedAt: null,
  ...overrides,
});

const facts = (overrides: Partial<BlockerFacts> = {}): BlockerFacts => ({
  approvalChatIds: new Set(),
  takeoverChatIds: new Set(),
  online: true,
  ...overrides,
});

// Midday, so the tests don't depend on the hour they run at.
const now = new Date(2026, 10, 22, 12);

describe("due days", () => {
  it("counts calendar days, not 24-hour spans", () => {
    expect(daysUntil("2026-11-22", now)).toBe(0);
    expect(daysUntil("2026-11-23", new Date(2026, 10, 22, 23, 59))).toBe(1);
    expect(daysUntil("2026-11-21", new Date(2026, 10, 22, 0, 1))).toBe(-1);
    // Across a clock change (late March in Europe, early November in the US).
    expect(daysUntil("2026-04-05", new Date(2026, 2, 20, 12))).toBe(16);
  });

  it("reads like the web: Today, Tomorrow, Yesterday, then the date", () => {
    expect(dueLabel("2026-11-22", now)).toBe("Today");
    expect(dueLabel("2026-11-23", now)).toBe("Tomorrow");
    expect(dueLabel("2026-11-21", now)).toBe("Yesterday");
    expect(dueLabel("2026-12-05", now)).toBe("Dec 5");
    expect(dueLabel("2030-01-15", now)).toBe("Jan 15, 2030");
  });

  it("is overdue only while the task is open", () => {
    expect(dueState(task({ id: "a", dueOn: "2026-11-20" }), now)).toBe("overdue");
    expect(dueState(task({ id: "a", dueOn: "2026-11-20", status: "done" }), now)).toBe("later");
    expect(dueState(task({ id: "a", dueOn: "2026-11-22" }), now)).toBe("today");
    expect(dueState(task({ id: "a" }), now)).toBe("later");
  });

  it("writes a local day back as YYYY-MM-DD", () => {
    expect(formatDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("what holds a task up", () => {
  it("is an approval or take over in its chat, approvals first", () => {
    const t = task({ id: "a", chatId: "c" });
    expect(taskBlocker(t, facts({ approvalChatIds: new Set(["c"]) }))).toBe("approval");
    expect(taskBlocker(t, facts({ takeoverChatIds: new Set(["c"]) }))).toBe("takeover");
    expect(
      taskBlocker(t, facts({ approvalChatIds: new Set(["c"]), takeoverChatIds: new Set(["c"]) })),
    ).toBe("approval");
    expect(taskBlocker(t, facts({ approvalChatIds: new Set(["other"]) }))).toBeNull();
  });

  it("is the offline computer only for a teammate's task in progress", () => {
    const offline = facts({ online: false });
    expect(taskBlocker(task({ id: "a", status: "doing", ownerTeammateId: "t" }), offline)).toBe(
      "paused",
    );
    expect(taskBlocker(task({ id: "a", status: "doing" }), offline)).toBeNull();
    expect(taskBlocker(task({ id: "a", ownerTeammateId: "t" }), offline)).toBeNull();
  });

  it("is nothing once the task is done", () => {
    const done = task({ id: "a", status: "done", chatId: "c" });
    expect(taskBlocker(done, facts({ approvalChatIds: new Set(["c"]) }))).toBeNull();
  });
});

describe("the board's columns", () => {
  const tasks = [
    task({ id: "late", position: 3, dueOn: "2026-11-01", ownerTeammateId: "t" }),
    task({ id: "first", position: 1 }),
    task({ id: "blocked", position: 2, chatId: "c", ownerTeammateId: "t" }),
    task({ id: "doing", status: "doing", position: 1, ownerTeammateId: "t" }),
    task({ id: "old", status: "done", completedAt: "2026-11-01T10:00:00Z" }),
    task({ id: "new", status: "done", completedAt: "2026-11-20T10:00:00Z" }),
  ];
  const blockerOf = (entry: BoardTask) =>
    taskBlocker(entry, facts({ approvalChatIds: new Set(["c"]) }));
  const ids = (filter: "all" | "mine" | "attention") =>
    boardColumns(tasks, blockerOf, filter, now).map((column) => [
      column.status,
      column.tasks.map((entry) => entry.id),
    ]);

  it("puts what waits on you first, then board order; done most recent first", () => {
    expect(ids("all")).toEqual([
      ["todo", ["blocked", "first", "late"]],
      ["doing", ["doing"]],
      ["done", ["new", "old"]],
    ]);
  });

  it("filters to yours, or to what needs you or is overdue", () => {
    expect(ids("mine")).toEqual([
      ["todo", ["first"]],
      ["doing", []],
      ["done", ["new", "old"]],
    ]);
    expect(ids("attention")).toEqual([
      ["todo", ["blocked", "late"]],
      ["doing", []],
      ["done", []],
    ]);
  });

  it("counts your open tasks and what needs you", () => {
    expect(filterCounts(tasks, blockerOf, now)).toEqual({ mine: 1, attention: 2 });
  });
});

describe("moving a task in its column", () => {
  const column = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 4 },
  ];

  it("lands halfway between the two it moves between", () => {
    expect(stepPosition(column, "c", "up")).toBe(1.5);
    expect(stepPosition(column, "a", "down")).toBe(3);
  });

  it("goes one past the end when it becomes first or last", () => {
    expect(stepPosition(column, "b", "up")).toBe(0);
    expect(stepPosition(column, "b", "down")).toBe(5);
  });

  it("can't move past the ends, or a task that isn't there", () => {
    expect(stepPosition(column, "a", "up")).toBeNull();
    expect(stepPosition(column, "c", "down")).toBeNull();
    expect(stepPosition(column, "x", "up")).toBeNull();
  });

  it("orders by position, whatever order the column was given in", () => {
    expect(stepPosition([...column].reverse(), "c", "up")).toBe(1.5);
  });

  it("puts a moved task after every other one", () => {
    expect(endPosition(column)).toBe(5);
    expect(endPosition(column, "c")).toBe(3);
    expect(endPosition([])).toBe(1);
  });
});
