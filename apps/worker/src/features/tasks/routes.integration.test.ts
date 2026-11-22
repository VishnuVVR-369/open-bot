import { runs, tasks, teammates } from "@open-bot/db";
import type { TaskStatus } from "@open-bot/domain";
import { asc, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, pool, worker, newTeammate, racedWhileLocked } = h;
  const BOARD_LOCK = "select pg_advisory_xact_lock(hashtextextended('task_board', 0))";

  beforeEach(async () => {
    await db.delete(tasks);
  });

  /** The column's titles in board order, with their positions. */
  async function column(status: TaskStatus) {
    return (
      await db
        .select({ title: tasks.title, position: tasks.position })
        .from(tasks)
        .where(eq(tasks.status, status))
        .orderBy(asc(tasks.position), asc(tasks.id))
    ).map(({ title, position }) => `${title}@${position}`);
  }

  /** Tasks with these titles in To do, at these positions (all 1 by default), by title. */
  async function seed(titles: string[], positions: number[] = titles.map(() => 1)) {
    const rows = await db
      .insert(tasks)
      .values(
        titles.map((title, n) => ({ title, position: positions[n]!, createdBy: "user" as const })),
      )
      .returning();
    return Object.fromEntries(rows.map((row) => [row.title, row.id]));
  }

  it("tasks: creates, moves and deletes one", async () => {
    const { id } = await worker.tasks.create({ title: "Write the launch post" });
    await worker.tasks.update({ taskId: id, status: "doing", notes: "Draft first" });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(task).toMatchObject({ status: "doing", notes: "Draft first" });
    await worker.tasks.remove({ taskId: id });
    expect(await db.select().from(tasks).where(eq(tasks.id, id))).toEqual([]);
  });

  it("tasks: gives one to a teammate and takes it back", async () => {
    const [owner] = await db
      .insert(teammates)
      .values({ name: "Ivy", slug: "ivy-tasks", role: "Travel", color: "#123456" })
      .returning();
    const { id } = await worker.tasks.create({ title: "Book flights", ownerTeammateId: owner!.id });
    const ownerOf = async () =>
      (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!.ownerTeammateId;
    expect(await ownerOf()).toBe(owner!.id);
    await worker.tasks.update({ taskId: id, ownerTeammateId: null });
    expect(await ownerOf()).toBeNull();
    await worker.tasks.update({ taskId: id, ownerTeammateId: owner!.id });
    expect(await ownerOf()).toBe(owner!.id);
  });

  it("tasks: gives tasks added or moved at once their own places", async () => {
    const added = await Promise.all(
      Array.from({ length: 8 }, (_, index) => worker.tasks.create({ title: `Parallel ${index}` })),
    );
    const places = async (status: "todo" | "doing") =>
      (await db.select().from(tasks).where(eq(tasks.status, status))).map((row) => row.position);
    const todo = await places("todo");
    expect(new Set(todo).size).toBe(todo.length);
    await Promise.all(added.map(({ id }) => worker.tasks.update({ taskId: id, status: "doing" })));
    const doing = await places("doing");
    expect(new Set(doing).size).toBe(doing.length);
  });

  it("tasks: moves one to the end, or before or after another, in any column", async () => {
    const id = await seed(["A", "B", "C"], [1, 2, 4]);
    await worker.tasks.move({
      taskId: id.C!,
      status: "todo",
      placement: { kind: "before", taskId: id.B! },
    });
    expect(await column("todo")).toEqual(["A@1", "C@1.5", "B@2"]);
    await worker.tasks.move({
      taskId: id.A!,
      status: "todo",
      placement: { kind: "after", taskId: id.B! },
    });
    expect(await column("todo")).toEqual(["C@1.5", "B@2", "A@3"]);
    await worker.tasks.move({ taskId: id.B!, status: "doing", placement: { kind: "end" } });
    expect(await column("doing")).toEqual(["B@1"]);
    await worker.tasks.move({
      taskId: id.C!,
      status: "doing",
      placement: { kind: "before", taskId: id.B! },
    });
    expect(await column("doing")).toEqual(["C@0", "B@1"]);
    expect(await column("todo")).toEqual(["A@3"]);
    await worker.tasks.move({ taskId: id.A!, status: "done", placement: { kind: "end" } });
    const [done] = await db.select().from(tasks).where(eq(tasks.id, id.A!));
    expect(done!.completedAt).not.toBeNull();
    await worker.tasks.move({ taskId: id.A!, status: "todo", placement: { kind: "end" } });
    const [reopened] = await db.select().from(tasks).where(eq(tasks.id, id.A!));
    expect(reopened!.completedAt).toBeNull();
  });

  it("tasks: numbers a column again, in one change, when a move lands between tied tasks", async () => {
    // Three tasks share position 1, so the board draws them by id: first, second, third.
    const id = await seed(["A", "B", "C"]);
    const [first, second, third] = (await column("todo")).map((entry) => entry.split("@")[0]!);
    // Moving the first down puts it after the second: second, first, third.
    await worker.tasks.move({
      taskId: id[first!]!,
      status: "todo",
      placement: { kind: "after", taskId: id[second!]! },
    });
    expect(await column("todo")).toEqual([`${second}@1`, `${first}@2`, `${third}@3`]);
  });

  it("tasks: refuses to place one next to a task in another column, and changes nothing", async () => {
    const id = await seed(["A", "B"], [1, 2]);
    await worker.tasks.update({ taskId: id.B!, status: "doing" });
    expect(
      await failure(
        worker.tasks.move({
          taskId: id.A!,
          status: "todo",
          placement: { kind: "before", taskId: id.B! },
        }),
      ),
    ).toEqual({
      status: 400,
      message: "The task it was moved next to isn't in that column anymore.",
    });
    expect(
      await failure(
        worker.tasks.move({
          taskId: id.A!,
          status: "doing",
          placement: { kind: "after", taskId: id.A! },
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(await column("todo")).toEqual(["A@1"]);
    expect(await column("doing")).toEqual(["B@1"]);
  });

  it("tasks: places a drop from a web app older than move before the task past its position", async () => {
    const id = await seed(["A", "B", "C"], [1, 2, 3]);
    await worker.tasks.update({ taskId: id.C!, position: 1.5 });
    expect(await column("todo")).toEqual(["A@1", "C@1.5", "B@2"]);
    // Dropped just above two tied tasks: it goes before them both.
    await seed(["D", "E"], [5, 5]);
    await worker.tasks.update({ taskId: id.A!, position: 4.9 });
    const titles = (await column("todo")).map((entry) => entry.split("@")[0]);
    expect(titles.slice(0, 3)).toEqual(["C", "B", "A"]);
    expect(titles.slice(3).sort()).toEqual(["D", "E"]);
  });

  it("tasks: a move and a start at once take their own places at the end of Doing", async () => {
    const ivy = await newTeammate("Ivy", "Travel");
    const id = await seed(["Start me", "Move me", "Move me too"], [1, 2, 3]);
    await db.update(tasks).set({ ownerTeammateId: ivy.id }).where(eq(tasks.id, id["Start me"]!));
    await racedWhileLocked<unknown>(BOARD_LOCK, () => [
      worker.tasks.start({ taskId: id["Start me"]! }),
      worker.tasks.move({ taskId: id["Move me"]!, status: "doing", placement: { kind: "end" } }),
      worker.tasks.move({
        taskId: id["Move me too"]!,
        status: "doing",
        placement: { kind: "end" },
      }),
    ]);
    const doing = await column("doing");
    expect(doing).toHaveLength(3);
    expect(new Set(doing.map((entry) => entry.split("@")[1])).size).toBe(3);
  });

  it("tasks: a new owner wasn't asked, so the last owner's chat goes with them", async () => {
    const ivy = await newTeammate("Ivy", "Travel");
    const kit = await newTeammate("Kit", "Research");
    const { id } = await worker.tasks.create({ title: "Book flights", ownerTeammateId: ivy.id });
    const { chatId } = await worker.tasks.start({ taskId: id });
    expect(chatId).toBe(ivy.chatId);
    const read = async () => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
    // Saving the same owner keeps the chat.
    await worker.tasks.update({ taskId: id, ownerTeammateId: ivy.id, title: "Book the flights" });
    expect((await read()).chatId).toBe(ivy.chatId);
    await worker.tasks.update({ taskId: id, ownerTeammateId: kit.id });
    expect(await read()).toMatchObject({ ownerTeammateId: kit.id, chatId: null });
    // Reopened, it still has no chat: Kit has yet to be asked.
    await worker.tasks.update({ taskId: id, status: "done" });
    await worker.tasks.update({ taskId: id, status: "todo" });
    expect(await read()).toMatchObject({ ownerTeammateId: kit.id, chatId: null, status: "todo" });
    await worker.tasks.start({ taskId: id });
    expect((await read()).chatId).toBe(kit.chatId);
  });

  it("tasks: a start that fails queues no run, so trying again asks once", async () => {
    const ivy = await newTeammate("Ivy", "Travel");
    const { id } = await worker.tasks.create({ title: "Renew passport", ownerTeammateId: ivy.id });
    const queued = async () =>
      (
        await db
          .select()
          .from(runs)
          .where(inArray(runs.chatId, [ivy.chatId]))
      ).filter((run) => run.prompt.includes(id));
    // The task's own write fails, after the run was saved in the same transaction.
    await pool.query(`
      create function refuse_task_start() returns trigger language plpgsql as $$
      begin raise exception 'task write refused'; end $$;
      create trigger refuse_task_start before update on tasks
        for each row when (new.status = 'doing') execute function refuse_task_start();`);
    try {
      expect((await failure(worker.tasks.start({ taskId: id }))).status).toBe(500);
    } finally {
      await pool.query(
        "drop trigger refuse_task_start on tasks; drop function refuse_task_start();",
      );
    }
    expect(await queued()).toEqual([]);
    await worker.tasks.start({ taskId: id });
    expect(await queued()).toHaveLength(1);
  });

  it("answers a failed query with the database's error, never its SQL or parameters", async () => {
    const logged = vi.mocked(ctx.log.error);
    logged.mockClear();
    // Postgres refuses a NUL byte in text, so the insert fails with the title as a parameter.
    expect(await failure(worker.tasks.create({ title: "A private\u0000title" }))).toEqual({
      status: 500,
      message: "The database refused the query (SQLSTATE 22021).",
    });
    expect(logged).toHaveBeenCalledOnce();
    const [, fields] = logged.mock.calls[0]!;
    expect(fields).toMatchObject({
      path: "/internal/tasks",
      error: "The database refused the query (SQLSTATE 22021).",
      query: expect.stringContaining('insert into "tasks"'),
      code: "22021",
    });
    expect(JSON.stringify(fields)).not.toContain("private");
  });
});
