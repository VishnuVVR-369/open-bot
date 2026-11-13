import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { tasks } from "@open-bot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = testDatabaseServer();

describe.skipIf(!url)("the task board's read", () => {
  const database = testDatabase(url);
  let listTasks: typeof import("./queries").listTasks;

  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    ({ listTasks } = await import("./queries"));
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/server/db");
    await pool.end();
    await database.drop();
  });

  it("lists open tasks in board order, then the 30 most recently finished", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n));
    await database.db.insert(tasks).values([
      { title: "Third", status: "todo", position: 2, createdBy: "user" },
      { title: "First", status: "doing", position: 0, createdBy: "user" },
      { title: "Second", status: "todo", position: 1, createdBy: "user" },
      ...Array.from({ length: 32 }, (_, n) => ({
        title: `Done ${n}`,
        status: "done" as const,
        createdBy: "user" as const,
        completedAt: day(n),
      })),
    ]);

    const board = await listTasks();

    expect(board.slice(0, 3).map((task) => task.title)).toEqual(["First", "Second", "Third"]);
    const done = board.slice(3);
    expect(done).toHaveLength(30);
    expect(done[0]).toMatchObject({ title: "Done 31", completedAt: day(31).toISOString() });
    expect(done.at(-1)?.title).toBe("Done 2");
    expect(board.every((task) => typeof task.createdAt === "string")).toBe(true);
  });
});
