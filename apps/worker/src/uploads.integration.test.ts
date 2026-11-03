import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chats, createDb, createPool, messages, uploads } from "@open-bot/db";
import {
  INCOMPLETE_TTL_MS,
  UNUSED_TTL_MS,
  UploadError,
  UploadService,
  type UploadFiles,
} from "./uploads";

const url = process.env.MOBILE_API_TEST_DATABASE_URL;

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
  const pool = createPool(url ?? "postgres://unused");
  const db = createDb(pool);
  let files: ReturnType<typeof memoryFiles>;
  let service: UploadService;

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_mobile_api_test")
      throw new Error(
        "Use the disposable openbot_mobile_api_test database (pnpm test:mobile-api).",
      );
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)),
    });
  });
  beforeEach(async () => {
    await pool.query("truncate uploads, chats restart identity cascade");
    files = memoryFiles();
    service = new UploadService(db, files.api, { warn: vi.fn() });
  });
  afterAll(async () => {
    await pool.end();
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
});
