import { createHash, randomUUID } from "node:crypto";
import {
  messages,
  runs,
  uploads,
  lockUploads,
  type Attachment,
  type Db,
  type Tx,
} from "@open-bot/db";
import { COMPUTER_PATHS, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/domain";
import { and, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { Context } from "./context";
import { errorMessage } from "./logger";

/** Where files you attach to messages, and files that arrive by email or Telegram, go on the computer. */
export const UPLOAD_DIR = `${COMPUTER_PATHS.shared}/uploads`;

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "file"
  );
}

/** Files on the computer, as uploads need them. The Codex file API in production. */
export interface UploadFiles {
  write(path: string, data: Buffer): Promise<void>;
  read(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
}

export function computerFiles(ctx: Pick<Context, "codex">): UploadFiles {
  return {
    async write(path, data) {
      const client = await ctx.codex.ready();
      await client.request("fs/createDirectory", { path: UPLOAD_DIR, recursive: true });
      await client.request("fs/writeFile", { path, dataBase64: data.toString("base64") });
    },
    async read(path) {
      const client = await ctx.codex.ready();
      const { dataBase64 } = await client.request("fs/readFile", { path });
      return Buffer.from(dataBase64, "base64");
    },
    async remove(path) {
      const client = await ctx.codex.ready();
      await client.request("fs/remove", { path, recursive: false, force: true });
    },
  };
}

export interface UploadInput {
  id: string;
  name: string;
  mime: string;
  /** What the sender says it sent, to catch a transfer that was cut short. */
  size: number;
  sha256: string;
  data: Buffer;
}

export interface UploadView {
  id: string;
  status: "writing" | "complete" | "failed";
  attachment: { name: string; path: string; mime: string; size: number } | null;
}

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Uploads that never finished are removed after this long. */
export const INCOMPLETE_TTL_MS = 60 * 60_000;
/** Finished uploads no message ever used are removed after this long. */
export const UNUSED_TTL_MS = 24 * 60 * 60_000;

/**
 * Attachments written exactly once per upload id: a retry writes the same path again (harmless)
 * until the file is complete, then returns it without writing. What was written is read back and
 * checked against the sender's size and SHA-256 before it counts as complete.
 */
export class UploadService {
  /** Uploads being written right now in this worker, so two retries don't write at once. */
  private readonly inFlight = new Map<string, Promise<UploadView>>();

  constructor(
    private readonly db: Db,
    private readonly files: UploadFiles,
    private readonly log: Pick<Context["log"], "warn">,
  ) {}

  static pathFor(id: string, name: string): string {
    return `${UPLOAD_DIR}/${id}-${sanitizeFileName(name)}`;
  }

  async put(input: UploadInput): Promise<UploadView> {
    if (input.size > MAX_UPLOAD_BYTES)
      throw new UploadError(413, `Files can be up to ${MAX_UPLOAD_LABEL}.`);
    if (!/^[0-9a-f]{64}$/.test(input.sha256))
      throw new UploadError(400, "The file's SHA-256 is missing or malformed.");
    // A cut-off transfer: say so, and the sender sends it again with the same id.
    if (input.data.length !== input.size || sha256(input.data) !== input.sha256)
      throw new UploadError(400, "The file didn't arrive in one piece. Try again.");
    const running = this.inFlight.get(input.id);
    if (running) {
      await running.catch(() => {});
      return this.put(input);
    }
    const work = this.write(input).finally(() => this.inFlight.delete(input.id));
    this.inFlight.set(input.id, work);
    return work;
  }

  private async write(input: UploadInput): Promise<UploadView> {
    const result = await this.db.transaction(async (tx) => {
      await lockUploads(tx, [UploadService.pathFor(input.id, input.name)]);
      try {
        return { value: await this.writeLocked(tx, input) };
      } catch (error) {
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.value;
  }

  private async writeLocked(tx: Tx, input: UploadInput): Promise<UploadView> {
    const path = UploadService.pathFor(input.id, input.name);
    const [existing] = await tx.select().from(uploads).where(eq(uploads.id, input.id));
    if (existing) {
      const same =
        existing.name === input.name &&
        existing.size === input.size &&
        existing.sha256 === input.sha256;
      if (!same) throw new UploadError(409, "That upload id was already used for another file.");
      if (existing.status === "complete") return view(existing);
      await tx
        .update(uploads)
        .set({ status: "writing", mime: input.mime, updatedAt: new Date() })
        .where(eq(uploads.id, input.id));
    } else {
      const [inserted] = await tx
        .insert(uploads)
        .values({
          id: input.id,
          path,
          name: input.name,
          mime: input.mime,
          size: input.size,
          sha256: input.sha256,
          status: "writing",
        })
        .onConflictDoNothing({ target: uploads.id })
        .returning();
      // Another worker took the same id at the same moment: let it finish, then ask again.
      if (!inserted) return this.writeLocked(tx, input);
    }

    try {
      await this.files.write(path, input.data);
      const written = await this.files.read(path);
      if (written.length !== input.size || sha256(written) !== input.sha256)
        throw new Error("the file on the computer doesn't match what was sent");
    } catch (error) {
      await tx
        .update(uploads)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(uploads.id, input.id));
      this.log.warn("upload failed", { uploadId: input.id, error: errorMessage(error) });
      throw error;
    }
    const [done] = await tx
      .update(uploads)
      .set({ status: "complete", updatedAt: new Date() })
      .where(eq(uploads.id, input.id))
      .returning();
    return view(done!);
  }

  /**
   * Keep a file that arrived some other way (an email, Telegram) as an upload under a new id, so
   * it's checked and cleaned up like one. Nothing retries these with the same id; the caller saves
   * what refers to it right away, long before cleanup would count it as unused.
   */
  async save(file: { name: string; mime: string; data: Buffer }): Promise<Attachment> {
    const { attachment } = await this.put({
      id: randomUUID(),
      name: file.name,
      mime: file.mime,
      size: file.data.length,
      sha256: sha256(file.data),
      data: file.data,
    });
    if (!attachment) throw new Error(`${file.name} wasn't saved.`);
    return attachment;
  }

  async status(id: string): Promise<UploadView | null> {
    const [row] = await this.db.select().from(uploads).where(eq(uploads.id, id));
    return row ? view(row) : null;
  }

  /** Removes uploads that never finished, and finished ones no message or run uses. */
  async cleanup(now = Date.now()): Promise<number> {
    const incomplete = new Date(now - INCOMPLETE_TTL_MS);
    const unused = new Date(now - UNUSED_TTL_MS);
    const attached = sql`jsonb_build_array(jsonb_build_object('path', ${uploads.path}))`;
    // A message you sent, or a run that started without one (an email).
    const inMessage = this.db
      .select({ one: sql`1` })
      .from(messages)
      .where(sql`${messages.attachments} @> ${attached}`);
    const inRun = this.db
      .select({ one: sql`1` })
      .from(runs)
      .where(sql`${runs.attachments} @> ${attached}`);
    const eligible = or(
      and(inArray(uploads.status, ["writing", "failed"]), lt(uploads.updatedAt, incomplete)),
      and(
        eq(uploads.status, "complete"),
        lt(uploads.updatedAt, unused),
        notExists(inMessage),
        notExists(inRun),
      ),
    );
    const stale = await this.db
      .select({ id: uploads.id, path: uploads.path })
      .from(uploads)
      .where(eligible)
      .limit(200);
    let removed = 0;
    for (const upload of stale) {
      if (this.inFlight.has(upload.id)) continue;
      const deleted = await this.db.transaction(async (tx) => {
        await lockUploads(tx, [upload.path]);
        const [candidate] = await tx
          .select({ id: uploads.id })
          .from(uploads)
          .where(and(eq(uploads.id, upload.id), eligible));
        if (!candidate) return false;
        try {
          await this.files.remove(upload.path);
        } catch (error) {
          if (!/no such file|not found/i.test(errorMessage(error))) {
            this.log.warn("couldn't remove an old upload", {
              uploadId: upload.id,
              error: errorMessage(error),
            });
            return false;
          }
        }
        await tx.delete(uploads).where(eq(uploads.id, upload.id));
        return true;
      });
      if (deleted) removed += 1;
    }
    return removed;
  }
}

function view(row: typeof uploads.$inferSelect): UploadView {
  return {
    id: row.id,
    status: row.status,
    attachment:
      row.status === "complete"
        ? { name: row.name, path: row.path, mime: row.mime, size: row.size }
        : null,
  };
}
