import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { teammates, chats, messages, runs, uploads, LOCKS, lockUntilCommit } from "@open-bot/db";
import {
  INCOMPLETE_TTL_MS,
  UNUSED_TTL_MS,
  UploadError,
  UploadService,
  type UploadFiles,
} from "./service";

import type { Context } from "../../context";
import { ChatService } from "../chat";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const url = testDatabaseServer();

/** A computer's files in memory, counting writes, with failures on demand. */
function memoryFiles() {
  const files = new Map<string, Buffer>();
  const state = { writes: 0, failNextWrite: false, corruptNextRead: false };
  const api: UploadFiles = {
    async write(path, data) {
      state.writes += 1;
      // Slow enough that two requests for the same upload overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (state.failNextWrite) {
        state.failNextWrite = false;
        // Half the file made it before the computer went away.
        files.set(path, data.subarray(0, Math.floor(data.length / 2)));
        throw new Error("computer went away");
      }
      files.set(path, Buffer.from(data));
    },
    async read(path) {
      const data = files.get(path);
      if (!data) throw new Error("no such file");
      if (state.corruptNextRead) {
        state.corruptNextRead = false;
        return Buffer.concat([data, Buffer.from("x")]);
      }
      return data;
    },
    async remove(path) {
      if (!files.delete(path)) throw new Error("No such file or directory");
    },
  };
  return { api, files, state };
}

function file(text: string, name = "photo.jpg") {
  const data = Buffer.from(text);
  return {
    id: randomUUID(),
    name,
    mime: "image/jpeg",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}

/** Uploading attachments exactly once per id, however often (and however concurrently) it's tried. */
describe.skipIf(!url)("uploads with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  let files: ReturnType<typeof memoryFiles>;
  let service: UploadService;

  beforeAll(async () => {
    await database.create();
  });
  beforeEach(async () => {
    await pool.query("truncate uploads, chats, bots restart identity cascade");
    files = memoryFiles();
    service = new UploadService(db, files.api, { warn: vi.fn() });
  });
  afterAll(async () => {
    await database.drop();
  });

  it("writes a file once, at a path that comes from its id", async () => {
    const upload = file("a photo of the receipt");
    const first = await service.put(upload);
    expect(first).toEqual({
      id: upload.id,
      status: "complete",
      attachment: {
        name: "photo.jpg",
        path: `/home/bot/shared/uploads/${upload.id}-photo.jpg`,
        mime: "image/jpeg",
        size: upload.size,
      },
    });
    // The response was lost and the phone sends it again: the same file, not written again.
    expect(await service.put(upload)).toEqual(first);
    expect(files.state.writes).toBe(1);
    expect(files.files.size).toBe(1);
    expect(await service.status(upload.id)).toEqual(first);
  });

  it("writes it once when the same upload arrives twice at the same moment", async () => {
    const upload = file("sent twice at once");
    const [a, b] = await Promise.all([service.put(upload), service.put(upload)]);
    expect(a).toEqual(b);
    expect(files.state.writes).toBe(1);
  });

  it("refuses the same id for a different file", async () => {
    const upload = file("the first file");
    await service.put(upload);
    const other = { ...file("another file entirely"), id: upload.id };
    await expect(service.put(other)).rejects.toMatchObject({ status: 409 });
    expect(files.state.writes).toBe(1);
  });

  it("refuses a transfer that was cut short, without saving anything", async () => {
    const upload = file("this one was cut off");
    const cut = { ...upload, data: upload.data.subarray(0, 5) };
    await expect(service.put(cut)).rejects.toBeInstanceOf(UploadError);
    expect(await service.status(upload.id)).toBeNull();
    expect(files.state.writes).toBe(0);
  });

  it("writes the same path again after a failed write, then completes", async () => {
    const upload = file("the computer restarted halfway");
    files.state.failNextWrite = true;
    await expect(service.put(upload)).rejects.toThrow("computer went away");
    expect((await service.status(upload.id))?.status).toBe("failed");
    const done = await service.put(upload);
    expect(done.status).toBe("complete");
    expect(files.files.size).toBe(1);
    expect(files.files.get(done.attachment!.path)).toEqual(upload.data);
  });

  it("doesn't call a file complete when what's on the computer doesn't match", async () => {
    const upload = file("read back wrong");
    files.state.corruptNextRead = true;
    await expect(service.put(upload)).rejects.toThrow("doesn't match");
    expect((await service.status(upload.id))?.status).toBe("failed");
    expect((await service.put(upload)).status).toBe("complete");
  });

  it("cleans up unfinished uploads after an hour and unused ones after a day", async () => {
    const [chat] = await db.insert(chats).values({ kind: "group", title: "Trip" }).returning();
    const used = await service.put(file("attached to a message", "used.jpg"));
    const unused = await service.put(file("never sent", "unused.jpg"));
    const fresh = await service.put(file("just uploaded", "fresh.jpg"));
    const broken = file("never finished", "broken.jpg");
    files.state.failNextWrite = true;
    await service.put(broken).catch(() => {});
    await db.insert(messages).values({
      chatId: chat!.id,
      role: "user",
      text: "Here it is",
      attachments: [used.attachment!],
    });
    const old = new Date(Date.now() - UNUSED_TTL_MS - 60_000);
    for (const id of [used.id, unused.id, broken.id])
      await db.update(uploads).set({ updatedAt: old }).where(eq(uploads.id, id));

    expect(await service.cleanup()).toBe(2);
    expect(await service.status(used.id)).not.toBeNull();
    expect(await service.status(fresh.id)).not.toBeNull();
    expect(await service.status(unused.id)).toBeNull();
    expect(await service.status(broken.id)).toBeNull();
    expect([...files.files.keys()].sort()).toEqual(
      [used.attachment!.path, fresh.attachment!.path].sort(),
    );
    // An unfinished one younger than an hour is still being written, or about to be retried.
    const recent = file("still uploading", "recent.jpg");
    files.state.failNextWrite = true;
    await service.put(recent).catch(() => {});
    await db
      .update(uploads)
      .set({ updatedAt: new Date(Date.now() - INCOMPLETE_TTL_MS + 60_000) })
      .where(eq(uploads.id, recent.id));
    expect(await service.cleanup()).toBe(0);
  });

  it("keeps a file that arrived by email or Telegram as a checked upload under a new id", async () => {
    const data = Buffer.from("Gate B12, boarding at 09:10");
    const saved = await service.save({ name: "notes?.txt", mime: "text/plain", data });
    expect(saved).toEqual({
      name: "notes?.txt",
      path: expect.stringMatching(/^\/home\/bot\/shared\/uploads\/[0-9a-f-]{36}-notes_\.txt$/),
      mime: "text/plain",
      size: data.length,
    });
    expect(files.files.get(saved.path)).toEqual(data);
    const [row] = await db.select().from(uploads).where(eq(uploads.path, saved.path));
    expect(row).toMatchObject({
      status: "complete",
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    // The same file arriving again (a second email) is a second upload, not a clash.
    const again = await service.save({ name: "notes?.txt", mime: "text/plain", data });
    expect(again.path).not.toBe(saved.path);
    // A write the computer garbled isn't kept as complete.
    files.state.corruptNextRead = true;
    await expect(service.save({ name: "bad.txt", mime: "text/plain", data })).rejects.toThrow(
      "doesn't match",
    );
  });

  it("keeps a file a run uses, like an email's, and removes one nothing used", async () => {
    const [chat] = await db.insert(chats).values({ kind: "inbox", title: "Email" }).returning();
    const [teammate] = await db
      .insert(teammates)
      .values({ name: "Iris", slug: "iris", role: "assistant", color: "violet" })
      .returning();
    const emailed = await service.save({
      name: "itinerary.pdf",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.7"),
    });
    // Saved, but the message that would have used it never was (Telegram, before a crash).
    const orphan = await service.save({
      name: "photo-12.jpg",
      mime: "image/jpeg",
      data: Buffer.from("jpeg"),
    });
    await db.insert(runs).values({
      chatId: chat!.id,
      teammateId: teammate!.id,
      trigger: "email",
      prompt: "An email",
      attachments: [emailed],
    });
    await db
      .update(uploads)
      .set({ updatedAt: new Date(Date.now() - UNUSED_TTL_MS - 60_000) })
      .where(inArray(uploads.path, [emailed.path, orphan.path]));

    expect(await service.cleanup()).toBe(1);
    expect([...files.files.keys()]).toEqual([emailed.path]);
    expect(await db.select({ path: uploads.path }).from(uploads)).toEqual([{ path: emailed.path }]);
  });

  it("rejects attachment acceptance once cleanup has claimed the file", async () => {
    const [chat] = await db.insert(chats).values({ kind: "group", title: "Trip" }).returning();
    const uploaded = await service.put(file("aged draft"));
    await db
      .update(uploads)
      .set({ updatedAt: new Date(Date.now() - UNUSED_TTL_MS - 60_000) })
      .where(eq(uploads.id, uploaded.id));
    const removing = deferred();
    const release = deferred();
    const remove = files.api.remove;
    files.api.remove = async (path) => {
      removing.resolve();
      await release.promise;
      await remove(path);
    };
    const cleanup = service.cleanup();
    await removing.promise;
    const chatService = new ChatService(
      { db, pool, log: { warn: vi.fn() } } as unknown as Context,
      async () => {},
    );
    const send = chatService.send({
      clientId: randomUUID(),
      chatId: chat!.id,
      text: "Here",
      attachments: [uploaded.attachment!],
      mentions: [],
    });
    const rejected = expect(send).rejects.toMatchObject({
      status: 400,
      message: "photo.jpg didn't finish uploading. Attach it again.",
    });
    release.resolve();
    expect(await cleanup).toBe(1);
    await rejected;
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("rechecks each stale candidate after a sender commits under the upload lock", async () => {
    const [chat] = await db.insert(chats).values({ kind: "group", title: "Trip" }).returning();
    const uploaded = await service.put(file("accepted aged draft"));
    const unrelated = await service.put(file("unused aged draft", "unused.jpg"));
    await db
      .update(uploads)
      .set({ updatedAt: new Date(Date.now() - UNUSED_TTL_MS - 60_000) })
      .where(eq(uploads.id, uploaded.id));
    await db
      .update(uploads)
      .set({ updatedAt: new Date(Date.now() - UNUSED_TTL_MS - 60_000) })
      .where(eq(uploads.id, unrelated.id));
    const locked = deferred();
    const release = deferred();
    const accepting = db.transaction(async (tx) => {
      await lockUntilCommit(tx, LOCKS.upload(uploaded.attachment!.path));
      locked.resolve();
      await release.promise;
      await tx.insert(messages).values({
        chatId: chat!.id,
        role: "user",
        text: "Here",
        attachments: [uploaded.attachment!],
      });
    });
    await locked.promise;
    const cleanup = service.cleanup();
    await vi.waitFor(async () => {
      const { rows } = await pool.query(
        "select 1 from pg_locks where locktype = 'advisory' and not granted",
      );
      expect(rows.length).toBeGreaterThan(0);
    });
    release.resolve();
    await accepting;
    expect(await cleanup).toBe(1);
    expect(files.files.has(uploaded.attachment!.path)).toBe(true);
    expect((await service.status(uploaded.id))?.status).toBe("complete");
    expect(files.files.has(unrelated.attachment!.path)).toBe(false);
    expect(await service.status(unrelated.id)).toBeNull();
  });
});
