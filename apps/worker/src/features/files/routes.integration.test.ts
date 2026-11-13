import {
  bots as teammateRows, // vocabulary: allow
} from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, files, worker, newTeammate } = h;

  it("files: lists, reads, never overwrites, and keeps what the system needs", async () => {
    const listing = await worker.files.list({ path: "/home/bot/shared" });
    expect(listing.entries).toEqual([
      {
        name: "notes.md",
        path: "/home/bot/shared/notes.md",
        isDirectory: false,
        modifiedAt: "2026-11-08T00:00:00.000Z",
      },
    ]);
    expect(await worker.files.read({ path: "/home/bot/shared/notes.md" })).toEqual({
      path: "/home/bot/shared/notes.md",
      dataBase64: "aGk=",
    });
    expect(
      await worker.files.put({ dir: "/home/bot/shared", name: "notes.md", dataBase64: "eW8=" }),
    ).toEqual({ path: "/home/bot/shared/notes (2).md" });
    await worker.files.write({ path: "/home/bot/shared/new.txt", dataBase64: "" });
    await worker.files.remove({ path: "/home/bot/shared/new.txt" });
    expect(files.has("/home/bot/shared/new.txt")).toBe(false);
    expect(await failure(worker.files.read({ path: "/etc/passwd" }))).toEqual({
      status: 400,
      message: "Path must be inside /home/bot",
    });
    expect(await failure(worker.files.list({ path: "/home/bot/.codex" }))).toMatchObject({
      status: 403,
    });
    const created = await newTeammate("Hopper", "admiral");
    const [row] = await db.select().from(teammateRows).where(eq(teammateRows.id, created.id));
    expect(
      await failure(worker.files.remove({ path: `/home/bot/bots/${row!.slug}` })),
    ).toMatchObject({ status: 403 });
  });
});
