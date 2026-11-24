import { describe, expect, it } from "vitest";
import {
  boardColumns,
  daysUntil,
  dueLabel,
  dueState,
  filterCounts,
  formatDay,
  placeTask,
  stepPlacement,
  taskBlocker,
  wasAsked,
  withTaskMoved,
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

describe("placing a moved task", () => {
  const column = [
    task({ id: "a", position: 1 }),
    task({ id: "b", position: 2 }),
    task({ id: "c", position: 4 }),
  ];

  it("lands halfway between the two it goes between", () => {
    expect(placeTask(column, "c", { kind: "before", taskId: "b" })).toEqual([
      { id: "c", position: 1.5 },
    ]);
    expect(placeTask(column, "a", { kind: "after", taskId: "b" })).toEqual([
      { id: "a", position: 3 },
    ]);
  });

  it("goes one past an end, or first in an empty column", () => {
    expect(placeTask(column, "b", { kind: "before", taskId: "a" })).toEqual([
      { id: "b", position: 0 },
    ]);
    expect(placeTask(column, "b", { kind: "after", taskId: "c" })).toEqual([
      { id: "b", position: 5 },
    ]);
    expect(placeTask(column, "x", { kind: "end" })).toEqual([{ id: "x", position: 5 }]);
    expect(placeTask(column, "c", { kind: "end" })).toEqual([{ id: "c", position: 3 }]);
    expect(placeTask([], "x", { kind: "end" })).toEqual([{ id: "x", position: 1 }]);
  });

  it("refuses a task to go next to that isn't in the column, or is the task itself", () => {
    expect(placeTask(column, "x", { kind: "before", taskId: "y" })).toBeNull();
    expect(placeTask(column, "a", { kind: "after", taskId: "a" })).toBeNull();
  });

  it("numbers the column again when its neighbours share a position", () => {
    // A, B and C tied at 1, drawn A, B, C: moving A down puts it after B.
    const tied = ["a", "b", "c"].map((id) => task({ id, position: 1 }));
    expect(placeTask(tied, "a", { kind: "after", taskId: "b" })).toEqual([
      { id: "a", position: 2 },
      { id: "c", position: 3 },
    ]);
    // At an end, one past its neighbour is enough.
    expect(placeTask(tied, "c", { kind: "before", taskId: "a" })).toEqual([
      { id: "c", position: 0 },
    ]);
  });

  it("numbers the column again when halving runs out of room", () => {
    const close = [
      task({ id: "a", position: 1 }),
      task({ id: "b", position: 1 + Number.EPSILON }),
      task({ id: "c", position: 2 }),
    ];
    expect(placeTask(close, "c", { kind: "after", taskId: "a" })).toEqual([
      { id: "c", position: 2 },
      { id: "b", position: 3 },
    ]);
  });

  it("shows a move on the board at once, with its new status", () => {
    const board = [...column, task({ id: "d", status: "doing", position: 7 })];
    const moved = withTaskMoved(board, "a", "doing", { kind: "end" }, now)!;
    expect(moved.find((t) => t.id === "a")).toMatchObject({ status: "doing", position: 8 });
    // The others are the same objects, untouched.
    expect(moved.filter((t) => t.id !== "a")).toEqual(board.filter((t) => t.id !== "a"));
    const finished = withTaskMoved(board, "b", "done", { kind: "end" }, now)!;
    expect(finished.find((t) => t.id === "b")?.completedAt).toBe(now.toISOString());
    expect(withTaskMoved(board, "a", "doing", { kind: "before", taskId: "b" })).toBeNull();
    expect(withTaskMoved(board, "x", "doing", { kind: "end" })).toBeNull();
  });
});

describe("moving a task one step up or down", () => {
  const none = () => null;
  const column = [
    task({ id: "a", position: 1 }),
    task({ id: "b", position: 2 }),
    task({ id: "c", position: 4 }),
  ];
  const drawn = (
    tasks: BoardTask[],
    blockerOf = none as (t: BoardTask) => ReturnType<typeof taskBlocker>,
    filter: "all" | "mine" = "all",
  ) => boardColumns(tasks, blockerOf, filter, now)[0]!.tasks;

  it("goes before the task drawn above it, or after the one drawn below", () => {
    expect(stepPlacement(drawn(column), "c", "up", none)).toEqual({ kind: "before", taskId: "b" });
    expect(stepPlacement(drawn(column), "a", "down", none)).toEqual({ kind: "after", taskId: "b" });
  });

  it("can't move past the ends, out of Done, or a task that isn't there", () => {
    expect(stepPlacement(drawn(column), "a", "up", none)).toBeNull();
    expect(stepPlacement(drawn(column), "c", "down", none)).toBeNull();
    expect(stepPlacement(drawn(column), "x", "up", none)).toBeNull();
    const done = [task({ id: "d", status: "done" }), task({ id: "e", status: "done" })];
    expect(stepPlacement(done, "e", "up", none)).toBeNull();
  });

  it("trades places only with tasks on its side of what waits on you", () => {
    // c waits on an approval, so the board draws c, a, b.
    const blocked = [...column.slice(0, 2), task({ id: "c", position: 3, chatId: "chat-c" })];
    const blockerOf = (t: BoardTask) => (t.chatId ? ("approval" as const) : null);
    const shown = drawn(blocked, blockerOf);
    expect(shown.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(stepPlacement(shown, "c", "up", blockerOf)).toBeNull();
    expect(stepPlacement(shown, "c", "down", blockerOf)).toBeNull();
    expect(stepPlacement(shown, "a", "up", blockerOf)).toBeNull();
    expect(stepPlacement(shown, "a", "down", blockerOf)).toEqual({ kind: "after", taskId: "b" });
    expect(stepPlacement(shown, "b", "up", blockerOf)).toEqual({ kind: "before", taskId: "a" });
    expect(stepPlacement(shown, "b", "down", blockerOf)).toBeNull();
  });

  it("steps over the tasks a filter hides, and lands before the next hidden one", () => {
    // Yours at 1 and 3, a teammate's at 2 and 4: Mine draws x, y.
    const tasks = [
      task({ id: "x", position: 1 }),
      task({ id: "t2", position: 2, ownerTeammateId: "ivy" }),
      task({ id: "y", position: 3 }),
      task({ id: "t4", position: 4, ownerTeammateId: "ivy" }),
    ];
    const shown = drawn(tasks, none, "mine");
    expect(shown.map((t) => t.id)).toEqual(["x", "y"]);
    const down = stepPlacement(shown, "x", "down", none)!;
    expect(down).toEqual({ kind: "after", taskId: "y" });
    // Placed against the whole column, it goes between y and the hidden task at 4, not on it.
    expect(placeTask(tasks, "x", down)).toEqual([{ id: "x", position: 3.5 }]);
    const up = stepPlacement(shown, "y", "up", none)!;
    expect(placeTask(tasks, "y", up)).toEqual([{ id: "y", position: 0 }]);
  });
});

describe("asking a task's owner", () => {
  it("asks again only when this owner was already asked", () => {
    expect(wasAsked(task({ id: "a", ownerTeammateId: "ivy", chatId: "c" }), "ivy")).toBe(true);
    // Moved to Doing by hand: nobody was asked.
    expect(wasAsked(task({ id: "a", ownerTeammateId: "ivy", status: "doing" }), "ivy")).toBe(false);
    // Given to someone else since.
    expect(wasAsked(task({ id: "a", ownerTeammateId: "ivy", chatId: "c" }), "kit")).toBe(false);
    expect(wasAsked(null, "ivy")).toBe(false);
  });
});
