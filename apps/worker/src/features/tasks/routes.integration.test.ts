import { tasks } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, worker } = h;

  it("tasks: creates, moves and deletes one", async () => {
    const { id } = await worker.tasks.create({ title: "Write the launch post" });
    await worker.tasks.update({ taskId: id, status: "doing", notes: "Draft first" });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(task).toMatchObject({ status: "doing", notes: "Draft first" });
    await worker.tasks.remove({ taskId: id });
    expect(await db.select().from(tasks).where(eq(tasks.id, id))).toEqual([]);
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
