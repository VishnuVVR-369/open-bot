import { describe, expect, it } from "vitest";
import {
  boardColumns,
  daysUntil,
  dueLabel,
  dueState,
  endPosition,
  filterCounts,
  formatDay,
  stepTask,
  taskBlocker,
  wasAsked,
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

describe("moving a task in its column", () => {
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

  it("lands halfway between the two it moves between", () => {
    expect(stepTask(drawn(column), "c", "up", none)).toEqual([{ id: "c", position: 1.5 }]);
    expect(stepTask(drawn(column), "a", "down", none)).toEqual([{ id: "a", position: 3 }]);
  });

  it("goes one past the end when it becomes first or last", () => {
    expect(stepTask(drawn(column), "b", "up", none)).toEqual([{ id: "b", position: 0 }]);
    expect(stepTask(drawn(column), "b", "down", none)).toEqual([{ id: "b", position: 5 }]);
  });

  it("can't move past the ends, out of Done, or a task that isn't there", () => {
    expect(stepTask(drawn(column), "a", "up", none)).toBeNull();
    expect(stepTask(drawn(column), "c", "down", none)).toBeNull();
    expect(stepTask(drawn(column), "x", "up", none)).toBeNull();
    const done = [task({ id: "d", status: "done" }), task({ id: "e", status: "done" })];
    expect(stepTask(done, "e", "up", none)).toBeNull();
  });

  it("trades places only with tasks on its side of what waits on you", () => {
    // c waits on an approval, so the board draws c, a, b.
    const blocked = [...column.slice(0, 2), task({ id: "c", position: 3, chatId: "chat-c" })];
    const blockerOf = (t: BoardTask) => (t.chatId ? ("approval" as const) : null);
    const shown = drawn(blocked, blockerOf);
    expect(shown.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(stepTask(shown, "c", "up", blockerOf)).toBeNull();
    expect(stepTask(shown, "c", "down", blockerOf)).toBeNull();
    expect(stepTask(shown, "a", "up", blockerOf)).toBeNull();
    expect(stepTask(shown, "a", "down", blockerOf)).toEqual([{ id: "a", position: 3 }]);
    expect(stepTask(shown, "b", "up", blockerOf)).toEqual([{ id: "b", position: 0 }]);
    expect(stepTask(shown, "b", "down", blockerOf)).toBeNull();
  });

  it("steps over the tasks a filter hides, so one tap moves it", () => {
    const tasks = [
      task({ id: "x", position: 1 }),
      ...[2, 3, 4].map((position) =>
        task({ id: `t${position}`, position, ownerTeammateId: "ivy" }),
      ),
      task({ id: "y", position: 5 }),
    ];
    const shown = drawn(tasks, none, "mine");
    expect(shown.map((t) => t.id)).toEqual(["x", "y"]);
    expect(stepTask(shown, "x", "down", none)).toEqual([{ id: "x", position: 6 }]);
    expect(stepTask(shown, "y", "up", none)).toEqual([{ id: "y", position: 0 }]);
  });

  it("numbers the column again when its neighbours share a position", () => {
    const tied = ["a", "b", "c", "d"].map((id) => task({ id, position: 1 }));
    const shown = drawn(tied);
    expect(shown.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    // a, c, b, d: b lands between c and d, which share position 1.
    expect(stepTask(shown, "b", "down", none)).toEqual([
      { id: "c", position: 2 },
      { id: "b", position: 3 },
      { id: "d", position: 4 },
    ]);
    // At an end, one past its neighbour is enough.
    expect(stepTask(shown, "b", "up", none)).toEqual([{ id: "b", position: 0 }]);
  });

  it("numbers the column again when halving runs out of room", () => {
    const close = [
      task({ id: "a", position: 1 }),
      task({ id: "b", position: 1 + Number.EPSILON }),
      task({ id: "c", position: 2 }),
    ];
    expect(stepTask(drawn(close), "c", "up", none)).toEqual([
      // a and c keep 1 and 2; only b moves.
      { id: "b", position: 3 },
    ]);
  });

  it("puts a moved task after every other one", () => {
    expect(endPosition(column)).toBe(5);
    expect(endPosition(column, "c")).toBe(3);
    expect(endPosition([])).toBe(1);
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
