import type { TaskView } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import {
  calendarWeeks,
  deleteQuestion,
  dueShortcuts,
  emptyTaskForm,
  homeTasks,
  monthOf,
  newTask,
  newTaskHref,
  startLabel,
  taskChanges,
  taskForm,
  taskFormChanged,
  taskFormProblem,
  taskRowLabel,
  teammateTasks,
  weekdayNames,
  weekStartFrom,
  withAddedTask,
} from "./tasks";

const task = (overrides: Partial<TaskView> & { id: string }): TaskView => ({
  title: "Book flights",
  notes: "",
  status: "todo",
  ownerTeammateId: null,
  dueOn: null,
  position: 1,
  createdBy: "user",
  createdByTeammateId: null,
  chatId: null,
  completedAt: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

const now = new Date(2026, 10, 22, 12);

describe("the task form", () => {
  it("needs a title, and keeps to the worker's limits", () => {
    expect(taskFormProblem(emptyTaskForm())).toBe("Give the task a title.");
    expect(taskFormProblem({ ...emptyTaskForm(), title: "   " })).toBe("Give the task a title.");
    expect(taskFormProblem({ ...emptyTaskForm(), title: "x".repeat(201) })).toBe(
      "Keep the title under 200 characters.",
    );
    expect(taskFormProblem({ ...emptyTaskForm(), title: ` ${"x".repeat(200)} ` })).toBeNull();
    expect(taskFormProblem({ ...emptyTaskForm(), title: "Go", notes: "n".repeat(8001) })).toBe(
      "Keep the notes under 8000 characters.",
    );
  });

  it("sends only what you changed, so a teammate's edit meanwhile isn't overwritten", () => {
    const start = taskForm(task({ id: "a", title: "Book flights", ownerTeammateId: "ivy" }));
    expect(taskChanges(start, start)).toEqual({});
    expect(taskChanges(start, { ...start, title: "Book flights " })).toEqual({});
    expect(
      taskChanges(start, {
        ...start,
        title: " Book trains ",
        ownerTeammateId: null,
        dueOn: "2026-12-01",
        status: "doing",
      }),
    ).toEqual({
      title: "Book trains",
      ownerTeammateId: null,
      dueOn: "2026-12-01",
      status: "doing",
    });
    expect(taskChanges(start, { ...start, notes: "Window seat\n" })).toEqual({
      notes: "Window seat",
    });
  });

  it("knows when there is something to lose", () => {
    const start = emptyTaskForm("ivy");
    expect(taskFormChanged(start, start)).toBe(false);
    expect(taskFormChanged(start, { ...start, title: "  " })).toBe(false);
    expect(taskFormChanged(start, { ...start, dueOn: "2026-12-01" })).toBe(true);
  });

  it("starts a new task with the teammate it was added for", () => {
    expect(emptyTaskForm("ivy").ownerTeammateId).toBe("ivy");
    expect(newTask({ ...emptyTaskForm("ivy"), title: " Pack ", notes: " Light " })).toEqual({
      title: "Pack",
      notes: "Light",
      ownerTeammateId: "ivy",
      dueOn: null,
    });
    expect(newTaskHref("a b")).toBe("/tasks/new?owner=a%20b");
    expect(newTaskHref(null)).toBe("/tasks/new");
  });

  it("asks again for a task already in progress, like the web", () => {
    expect(startLabel("todo", "Ivy")).toBe("Ask Ivy to start");
    expect(startLabel("doing", "Ivy")).toBe("Ask Ivy again");
  });
});

describe("deleting a task", () => {
  it("says it's gone for everyone", () => {
    expect(deleteQuestion(task({ id: "a" }), null)).toEqual({
      title: "Delete this task?",
      body: "“Book flights” is removed from the board for you and every teammate.",
    });
  });

  it("warns that a teammate working on it may carry on", () => {
    const doing = task({ id: "a", status: "doing", ownerTeammateId: "ivy" });
    expect(deleteQuestion(doing, "Ivy").body).toBe(
      "“Book flights” is removed from the board for you and every teammate. Ivy may still be working on it in their chat.",
    );
    expect(deleteQuestion({ ...doing, status: "todo" }, "Ivy").body).not.toContain("Ivy");
  });
});

describe("tasks on Home and a teammate's profile", () => {
  const tasks = [
    task({ id: "todo", position: 1 }),
    task({ id: "doing", status: "doing", position: 5 }),
    task({ id: "later", position: 0, dueOn: "2026-12-20" }),
    task({ id: "tomorrow", position: 9, dueOn: "2026-11-23" }),
    task({ id: "late", position: 8, dueOn: "2026-11-02" }),
    task({ id: "blocked", position: 7, chatId: "c" }),
    task({ id: "done", status: "done", completedAt: "2026-11-21T10:00:00.000Z" }),
  ];
  const blockerOf = (entry: TaskView) => (entry.chatId === "c" ? "approval" : null);

  it("shows what needs you, then what's late or due soon, then work in progress", () => {
    expect(homeTasks(tasks, blockerOf, 10, now).map((entry) => entry.id)).toEqual([
      "blocked",
      "late",
      "tomorrow",
      "doing",
      "later",
      "todo",
    ]);
    expect(homeTasks(tasks, blockerOf, 2, now)).toHaveLength(2);
  });

  it("lists a teammate's open tasks, in progress first", () => {
    const theirs = [
      task({ id: "a", ownerTeammateId: "ivy", position: 2 }),
      task({ id: "b", ownerTeammateId: "ivy", status: "doing", position: 9 }),
      task({ id: "c", ownerTeammateId: "ivy", position: 1 }),
      task({ id: "d", ownerTeammateId: "rex" }),
      task({ id: "e", ownerTeammateId: "ivy", status: "done" }),
    ];
    expect(teammateTasks(theirs, "ivy").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });
});

describe("the due date picker", () => {
  it("lays a month out in whole weeks from the phone's first weekday", () => {
    // November 2026 starts on a Sunday.
    const monday = calendarWeeks(2026, 10, 1);
    expect(monday).toHaveLength(6);
    expect(monday[0]![0]).toEqual({ day: "2026-10-26", date: 26, inMonth: false });
    expect(monday[0]![6]).toEqual({ day: "2026-11-01", date: 1, inMonth: true });
    expect(monday.at(-1)!.at(-1)).toEqual({ day: "2026-12-06", date: 6, inMonth: false });
    const sunday = calendarWeeks(2026, 10, 0);
    expect(sunday).toHaveLength(5);
    expect(sunday[0]![0]!.day).toBe("2026-11-01");
    for (const week of [...monday, ...sunday]) expect(week).toHaveLength(7);
  });

  it("names the weekdays in the same order", () => {
    expect(weekdayNames(1)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(weekdayNames(0)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    expect(weekStartFrom(1)).toBe(0);
    expect(weekStartFrom(2)).toBe(1);
    expect(weekStartFrom(7)).toBe(6);
    expect(weekStartFrom(null)).toBe(1);
  });

  it("offers today, tomorrow and a week out, across a month's end", () => {
    expect(dueShortcuts(new Date(2026, 10, 30, 9))).toEqual([
      { label: "Today", day: "2026-11-30" },
      { label: "Tomorrow", day: "2026-12-01" },
      { label: "In a week", day: "2026-12-07" },
    ]);
  });

  it("opens on the due day's month, or this one", () => {
    expect(monthOf("2030-01-15", now)).toEqual({ year: 2030, month: 0 });
    expect(monthOf(null, now)).toEqual({ year: 2026, month: 10 });
  });
});

describe("a task just added", () => {
  const form = { ...emptyTaskForm("ivy"), title: "  Book flights  ", dueOn: "2026-12-01" };

  it("joins the board at the end of To do, as the worker puts it", () => {
    const board = [task({ id: "a", position: 3 }), task({ id: "b", position: 9, status: "doing" })];
    const added = withAddedTask(board, "new", form, now).at(-1);
    expect(added).toMatchObject({
      id: "new",
      title: "Book flights",
      ownerTeammateId: "ivy",
      dueOn: "2026-12-01",
      status: "todo",
      position: 4,
      createdBy: "user",
    });
  });

  it("isn't added twice once the board has it", () => {
    const board = [task({ id: "new", title: "From the server" })];
    expect(withAddedTask(board, "new", form, now)).toEqual(board);
  });
});

describe("a task row for TalkBack", () => {
  it("reads the owner and the due day with the rest", () => {
    expect(taskRowLabel(task({ id: "a", dueOn: "2026-11-20" }), "Ivy", "approval", now)).toBe(
      "Book flights, To do, Waiting for approval, Ivy, Overdue, due Nov 20",
    );
    expect(taskRowLabel(task({ id: "a", dueOn: "2026-11-22" }), "You", null, now)).toBe(
      "Book flights, To do, You, Due Today",
    );
    expect(
      taskRowLabel(task({ id: "a", dueOn: "2026-11-20", status: "done" }), "Ivy", null, now),
    ).toBe("Book flights, Done, Ivy, Due Nov 20");
    expect(taskRowLabel(task({ id: "a" }), "You", null, now)).toBe("Book flights, To do, You");
  });
});
