import type { TaskView } from "@open-bot/api";
import { PendingMoves, sendMove, withPendingMoves } from "@open-bot/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  afterSave,
  calendarWeeks,
  deleteQuestion,
  dueShortcuts,
  emptyTaskForm,
  homeTasks,
  monthOf,
  newTask,
  newTaskHref,
  rebaseTaskForm,
  startLabel,
  taskById,
  taskChanges,
  taskForm,
  taskFormChanged,
  taskFormProblem,
  taskRowLabel,
  taskScreenState,
  taskWrite,
  teammateTasks,
  weekdayNames,
  weekStartFrom,
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

  it("asks again only when the owner was already asked, like the web", () => {
    expect(startLabel("Ivy", false)).toBe("Ask Ivy to start");
    expect(startLabel("Ivy", true)).toBe("Ask Ivy again");
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

describe("saving the task screen", () => {
  const form = { ...emptyTaskForm("ivy"), title: "  Book flights  " };

  it("adds a new task once, then only updates it", () => {
    expect(taskWrite(null, emptyTaskForm("ivy"), form)).toEqual({
      kind: "create",
      input: { title: "Book flights", notes: "", ownerTeammateId: "ivy", dueOn: null },
    });
    // Added, but starting it failed: asking again uses the task it made, whatever the board holds.
    expect(taskWrite("new", form, form)).toEqual({ kind: "none", taskId: "new" });
    expect(taskWrite("new", form, { ...form, dueOn: "2026-12-01" })).toEqual({
      kind: "update",
      taskId: "new",
      changes: { dueOn: "2026-12-01" },
    });
  });
});

describe("what the task screen shows", () => {
  const open = task({ id: "a", status: "done" });
  const gone = (error: unknown) => error === "not found";

  it("shows the task, read on its own, even one the board no longer lists", () => {
    expect(taskScreenState({ data: open, error: null }, open, gone)).toEqual({
      kind: "task",
      task: open,
      gone: false,
    });
  });

  it("says it was deleted only when the server says it's gone", () => {
    expect(taskScreenState({ data: open, error: "not found" }, open, gone)).toEqual({
      kind: "task",
      task: open,
      gone: true,
    });
    // Offline or failing: the last copy stays, with no deletion notice.
    expect(taskScreenState({ data: undefined, error: "offline" }, open, gone)).toEqual({
      kind: "task",
      task: open,
      gone: false,
    });
  });

  it("says there's no such task, a failed read, or that it's loading", () => {
    expect(taskScreenState({ data: undefined, error: "not found" }, undefined, gone)).toEqual({
      kind: "missing",
    });
    expect(taskScreenState({ data: undefined, error: "offline" }, undefined, gone)).toEqual({
      kind: "error",
    });
    expect(taskScreenState({ data: undefined, error: null }, undefined, gone)).toEqual({
      kind: "loading",
    });
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

describe("the task screen while the task changes elsewhere", () => {
  const ada = "00000000-0000-4000-8000-00000000000a";
  const bea = "00000000-0000-4000-8000-00000000000b";

  it("follows what you haven't touched, so it never says Ask Ada for Bea's task", () => {
    const opened = taskForm(task({ id: "t", ownerTeammateId: ada }));
    const draft = { start: opened, form: { ...opened, title: "Book the flights" } };
    // Reassigned to Bea on the web while the phone showed "Ask Ada".
    const fresh = { ...opened, ownerTeammateId: bea, dueOn: "2026-12-01" };
    const rebased = rebaseTaskForm(draft, fresh);
    expect(rebased.form).toEqual({
      ...fresh,
      // Your own change stays yours.
      title: "Book the flights",
    });
    // And only it is sent.
    expect(taskChanges(rebased.start, rebased.form)).toEqual({ title: "Book the flights" });
  });

  it("keeps an owner you picked yourself, and comes back the same when nothing changed", () => {
    const opened = taskForm(task({ id: "t", ownerTeammateId: ada }));
    const draft = { start: opened, form: { ...opened, ownerTeammateId: null } };
    expect(rebaseTaskForm(draft, { ...opened, ownerTeammateId: bea }).form.ownerTeammateId).toBe(
      null,
    );
    expect(rebaseTaskForm(draft, { ...opened })).toBe(draft);
  });

  it("finds the held task as the board has it now, or none once it's gone", () => {
    const board = [task({ id: "a", ownerTeammateId: bea })];
    expect(taskById(board, "a")?.ownerTeammateId).toBe(bea);
    expect(taskById(board, "gone")).toBeNull();
    expect(taskById(board, null)).toBeNull();
  });
});

describe("where the task screen goes after saving", () => {
  const base = { focused: true, created: null, then: undefined } as const;

  it("goes back after a save, or to the chat the owner was asked in", () => {
    expect(afterSave(base)).toEqual({ kind: "back" });
    expect(afterSave({ ...base, then: "start", started: { chatId: "c" } })).toEqual({
      kind: "chat",
      chatId: "c",
    });
  });

  it("opens a task added here as itself when starting it failed, and stays on a saved one", () => {
    expect(afterSave({ ...base, created: "t", then: "start", started: null })).toEqual({
      kind: "task",
      taskId: "t",
    });
    expect(afterSave({ ...base, then: "start", started: null })).toEqual({ kind: "stay" });
  });

  it("goes nowhere from a screen you left while it saved, so it never pops another one", () => {
    expect(afterSave({ ...base, focused: false })).toEqual({ kind: "stay" });
    expect(afterSave({ ...base, focused: false, then: "start", started: { chatId: "c" } })).toEqual(
      { kind: "stay" },
    );
  });
});

describe("moving a task on the board, with TanStack Query", () => {
  const board = [task({ id: "a", position: 1 }), task({ id: "b", position: 2 })];

  /** A client holding the board, whose next reads fail if `failing` says so. */
  async function client(failing: () => boolean) {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["tasks"];
    const options = {
      queryKey: key,
      queryFn: async () => {
        if (failing()) throw new Error("offline");
        return board;
      },
    };
    await queries.fetchQuery(options);
    // An observer, like the board on screen, so invalidating reads it again.
    const { QueryObserver } = await import("@tanstack/react-query");
    const observer = new QueryObserver(queries, options);
    const stop = observer.subscribe(() => {});
    const shown = (pending: PendingMoves) =>
      withPendingMoves(
        queries.getQueryData<TaskView[]>(key) ?? [],
        pending.snapshot(),
        queries.getQueryState(key)!.dataUpdatedAt,
      )
        .filter((entry) => entry.status === "doing")
        .map((entry) => entry.id);
    const reread = () => queries.invalidateQueries({ queryKey: key });
    return { shown, reread, stop };
  }

  it("doesn't show a refused move, even when reading the board again fails too", async () => {
    let failing = false;
    const { shown, reread, stop } = await client(() => failing);
    failing = true;
    const pending = new PendingMoves();
    const answer = await sendMove(
      pending,
      { taskId: "a", status: "doing", placement: { kind: "end" } },
      async () => ({ error: new Error("That task no longer exists.") }),
      (result) => !result.error,
      reread,
    );
    await reread();
    expect(answer.error).toBeInstanceOf(Error);
    expect(shown(pending)).toEqual([]);
    stop();
  });

  it("keeps showing a move that was made while the board can't be read", async () => {
    let failing = false;
    const { shown, reread, stop } = await client(() => failing);
    failing = true;
    const pending = new PendingMoves();
    await sendMove(
      pending,
      { taskId: "a", status: "doing", placement: { kind: "end" } },
      async () => ({ error: null }),
      (result) => !result.error,
      reread,
    );
    await reread();
    expect(shown(pending)).toEqual(["a"]);
    stop();
  });
});
