import { randomUUID } from "node:crypto";
import type { ApiClient } from "@open-bot/api";
import { tasks } from "@open-bot/db";
import { ORPCError } from "@orpc/client";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

/**
 * The board's writes, as the browser and the phone send them, against a stand-in worker: the web
 * app and the worker deploy on their own, so each side has to work with the other's older version
 * while a deploy finishes.
 */
describe.skipIf(!apiTestUrl)("the task board's writes, through the web app", () => {
  const harness = apiHarness();
  const { database, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });
  beforeEach(async () => {
    await database.db.delete(tasks);
    workerBodies.length = 0;
    answers.clear();
  });

  /** Tasks in To do with these titles and positions, by title. */
  async function seed(entries: [string, number][]) {
    const rows = await database.db
      .insert(tasks)
      .values(entries.map(([title, position]) => ({ title, position, createdBy: "user" as const })))
      .returning();
    return Object.fromEntries(rows.map((row) => [row.title, row.id])) as Record<string, string>;
  }

  /** What the web app sent the worker for the tasks, in order. */
  const sent = () => workerBodies.filter((entry) => entry.path.startsWith("/internal/tasks"));
  const ok = { status: 200, body: { ok: true } };
  /** A worker's answer to a path it doesn't have. */
  const noRoute = { status: 404, body: { error: "not found", code: "NOT_FOUND" } };

  it("sends a move to the worker's move", async () => {
    const id = await seed([["A", 1]]);
    answers.set(`/internal/tasks/${id.A}/move`, ok);
    await api.tasks.move({ taskId: id.A!, status: "doing", placement: { kind: "end" } });
    expect(sent()).toEqual([
      {
        path: `/internal/tasks/${id.A}/move`,
        body: { status: "doing", placement: { kind: "end" } },
      },
    ]);
  });

  it("places a move itself for a worker from before move, and sends it as update", async () => {
    const id = await seed([
      ["A", 1],
      ["B", 2],
      ["C", 4],
    ]);
    answers.set(`/internal/tasks/${id.C}/move`, noRoute);
    answers.set(`/internal/tasks/${id.C}`, ok);
    await api.tasks.move({
      taskId: id.C!,
      status: "todo",
      placement: { kind: "before", taskId: id.B! },
    });
    expect(sent().slice(1)).toEqual([
      { path: `/internal/tasks/${id.C}`, body: { status: "todo", position: 1.5 } },
    ]);
  });

  it("renumbers tied tasks first for a worker from before move, which writes positions as given", async () => {
    const id = await seed([
      ["A", 1],
      ["B", 1],
      ["C", 1],
    ]);
    // The board's order where positions tie is by id.
    const [first, last] = Object.entries(id)
      .filter(([title]) => title !== "C")
      .map(([, taskId]) => taskId)
      .sort();
    answers.set(`/internal/tasks/${id.C}/move`, noRoute);
    for (const taskId of Object.values(id)) answers.set(`/internal/tasks/${taskId}`, ok);
    await api.tasks.move({
      taskId: id.C!,
      status: "todo",
      placement: { kind: "after", taskId: first! },
    });
    // The column is numbered again with C second: the one after it moves first, then C itself.
    expect(sent().slice(1)).toEqual([
      { path: `/internal/tasks/${last}`, body: { position: 3 } },
      { path: `/internal/tasks/${id.C}`, body: { status: "todo", position: 2 } },
    ]);
  });

  it("says why when the task it goes next to has left the column, for a worker from before move", async () => {
    const id = await seed([["A", 1]]);
    answers.set(`/internal/tasks/${id.A}/move`, noRoute);
    const error = await api.tasks
      .move({ taskId: id.A!, status: "todo", placement: { kind: "before", taskId: randomUUID() } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).message).toBe(
      "The task it was moved next to isn't in that column anymore.",
    );
    expect(sent()).toHaveLength(1);
  });

  it("passes on the worker's own refusals of a move, even a 404 with its own words", async () => {
    const id = await seed([["A", 1]]);
    answers.set(`/internal/tasks/${id.A}/move`, {
      status: 404,
      body: { error: "That task no longer exists.", code: "NOT_FOUND" },
    });
    const error = await api.tasks
      .move({ taskId: id.A!, status: "doing", placement: { kind: "end" } })
      .catch((caught: unknown) => caught);
    expect((error as ORPCError<string, unknown>).message).toBe("That task no longer exists.");
    expect(sent()).toHaveLength(1);
  });

  it("forwards the position a tab loaded before move still sends with update", async () => {
    const id = await seed([["A", 1]]);
    answers.set(`/internal/tasks/${id.A}`, ok);
    // The old board's drag: `update` with where it was dropped.
    await api.tasks.update({ taskId: id.A!, status: "doing", position: 0.5 });
    expect(sent()).toEqual([
      { path: `/internal/tasks/${id.A}`, body: { status: "doing", position: 0.5 } },
    ]);
  });

  it("forwards a start's id and the owner it was meant for", async () => {
    const id = await seed([["A", 1]]);
    answers.set(`/internal/tasks/${id.A}/start`, { status: 200, body: { chatId: null } });
    const ask = { startId: randomUUID(), expectedOwnerId: randomUUID() };
    await api.tasks.start({ taskId: id.A!, ...ask });
    expect(sent()).toEqual([{ path: `/internal/tasks/${id.A}/start`, body: ask }]);
  });
});
