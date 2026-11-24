import { describe, expect, it, vi } from "vitest";
import type { BoardTask } from "./board";
import { PendingMoves, sendMove, TaskStartKeys, withPendingMoves } from "./pending";

const task = (id: string, position: number, status: BoardTask["status"] = "todo"): BoardTask => ({
  id,
  status,
  position,
  ownerTeammateId: null,
  dueOn: null,
  chatId: null,
  completedAt: null,
});

/** The board's ids in each column, in order. */
const columns = (board: readonly BoardTask[]) =>
  Object.fromEntries(
    (["todo", "doing"] as const).map((status) => [
      status,
      board
        .filter((entry) => entry.status === status)
        .sort((a, b) => a.position - b.position)
        .map((entry) => entry.id),
    ]),
  );

describe("moves on their way, over the board the server sent", () => {
  const board = [task("a", 1), task("b", 2), task("c", 3)];

  it("shows a move at once, without touching the board the server sent", () => {
    const pending = new PendingMoves();
    pending.add("c", "doing", { kind: "end" });
    const shown = withPendingMoves(board, pending.snapshot(), 0);
    expect(columns(shown)).toEqual({ todo: ["a", "b"], doing: ["c"] });
    expect(columns(board)).toEqual({ todo: ["a", "b", "c"], doing: [] });
  });

  it("a refused move stops showing, even when reading the board again fails too", () => {
    const pending = new PendingMoves();
    const key = pending.add("c", "doing", { kind: "end" });
    pending.refused(key);
    // No new board came: the last one the server sent is drawn as it was.
    expect(columns(withPendingMoves(board, pending.snapshot(), 0))).toEqual({
      todo: ["a", "b", "c"],
      doing: [],
    });
  });

  it("a refused move doesn't undo another one, or what changed on the server meanwhile", () => {
    const pending = new PendingMoves();
    const first = pending.add("a", "doing", { kind: "end" });
    const second = pending.add("c", "todo", { kind: "before", taskId: "a" });
    pending.refused(first);
    // Meanwhile a teammate moved b to Doing; the server's board has it.
    const fresh = [task("a", 1), task("b", 1, "doing"), task("c", 3)];
    expect(columns(withPendingMoves(fresh, pending.snapshot(), 5))).toEqual({
      todo: ["c", "a"],
      doing: ["b"],
    });
    pending.refused(second);
    expect(columns(withPendingMoves(fresh, pending.snapshot(), 5))).toEqual({
      todo: ["a", "c"],
      doing: ["b"],
    });
  });

  it("a move the server made shows until a board sent after it, then goes", () => {
    const pending = new PendingMoves();
    const key = pending.add("c", "doing", { kind: "end" });
    pending.made(key, 10);
    // A board from before the server answered doesn't have it yet.
    expect(columns(withPendingMoves(board, pending.snapshot(), 9))).toEqual({
      todo: ["a", "b"],
      doing: ["c"],
    });
    // Nor may one read in the same millisecond; laid over one that has it, it changes nothing.
    const after = [task("a", 1), task("b", 2), task("c", 1, "doing")];
    expect(columns(withPendingMoves(after, pending.snapshot(), 10))).toEqual({
      todo: ["a", "b"],
      doing: ["c"],
    });
    pending.confirmed(10);
    expect(pending.snapshot()).toHaveLength(1);
    pending.confirmed(11);
    expect(pending.snapshot()).toEqual([]);
  });

  it("skips a move whose task is gone, and tells subscribers of every change", () => {
    const pending = new PendingMoves();
    const listener = vi.fn();
    const stop = pending.subscribe(listener);
    pending.add("gone", "doing", { kind: "end" });
    pending.add("a", "todo", { kind: "after", taskId: "c" });
    expect(columns(withPendingMoves(board, pending.snapshot(), 0)).todo).toEqual(["b", "c", "a"]);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    pending.add("b", "doing", { kind: "end" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("the id of an ask to start a task", () => {
  it("is kept for retries until the ask goes through, and is new for another owner", () => {
    let n = 0;
    const keys = new TaskStartKeys(() => `key-${++n}`);
    const first = keys.for("task", "ada");
    expect(keys.for("task", "ada")).toBe(first);
    expect(keys.for("task", "bea")).not.toBe(first);
    expect(keys.for("other", "ada")).not.toBe(first);
    keys.done("task", "ada");
    expect(keys.for("task", "ada")).not.toBe(first);
  });
});

describe("sending a move", () => {
  const board = [task("a", 1), task("b", 2)];

  it("stops showing a refusal before the caller says why, and reads the board again", async () => {
    const pending = new PendingMoves();
    const reread = vi.fn();
    let shownWhileSending: string[] = [];
    const answer = await sendMove(
      pending,
      { taskId: "a", status: "doing", placement: { kind: "end" } },
      async () => {
        shownWhileSending = columns(withPendingMoves(board, pending.snapshot(), 0)).doing!;
        return { ok: false as const };
      },
      (result) => result.ok,
      reread,
    );
    expect(answer).toEqual({ ok: false });
    expect(shownWhileSending).toEqual(["a"]);
    expect(pending.snapshot()).toEqual([]);
    expect(reread).toHaveBeenCalledOnce();
  });

  it("stops showing a move whose request threw", async () => {
    const pending = new PendingMoves();
    await expect(
      sendMove(
        pending,
        { taskId: "a", status: "doing", placement: { kind: "end" } },
        () => Promise.reject(new Error("offline")),
        () => true,
        () => {},
      ),
    ).rejects.toThrow("offline");
    expect(pending.snapshot()).toEqual([]);
  });

  it("keeps showing a move made until a board read after it", async () => {
    const pending = new PendingMoves();
    await sendMove(
      pending,
      { taskId: "a", status: "doing", placement: { kind: "end" } },
      async () => true,
      (made) => made,
      () => {},
      () => 42,
    );
    expect(pending.snapshot()).toMatchObject([{ taskId: "a", madeAt: 42 }]);
  });
});
