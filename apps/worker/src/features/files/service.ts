import { teammates } from "@open-bot/db";
import { COMPUTER_PATHS, undeletablePath } from "@open-bot/domain";
import { isNull } from "drizzle-orm";
import type { Context } from "../../context";
import { sanitizeFileName } from "../uploads";
import { WorkerError } from "../../core/errors";

export class FileError extends WorkerError {}

/** Only files inside the computer's home folders can be read or listed. */
export function safePath(path: string): string {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (!normalized.startsWith("/home/bot/") && normalized !== "/home/bot")
    throw new FileError(400, "Path must be inside /home/bot");
  if (normalized.split("/").includes("..")) throw new FileError(400, "Invalid path");
  if (normalized.startsWith(COMPUTER_PATHS.codexHome))
    throw new FileError(403, "That folder is private to Codex");
  return normalized;
}

/** "notes.md" becomes "notes (2).md" when the name is taken, so nothing is overwritten. */
export function freeFileName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let fileName = name;
  for (let i = 2; taken.has(fileName); i += 1) fileName = `${stem} (${i})${ext}`;
  return fileName;
}

/** The owner's view of the computer's files, through Codex's file system API. */
export class FileService {
  constructor(private readonly ctx: Pick<Context, "codex" | "db">) {}

  /** A folder's visible entries, with when each was last changed. */
  async list(folder: string = COMPUTER_PATHS.teammatesRoot) {
    const path = safePath(folder);
    const client = await this.ctx.codex.ready();
    const { entries } = await client.request("fs/readDirectory", { path });
    const detailed = await Promise.all(
      entries
        .filter((entry) => !entry.fileName.startsWith("."))
        .map(async (entry) => {
          // An entry can go between the listing and this lookup, or be unreadable: it is still
          // listed, without a date, rather than failing the whole folder.
          const meta = await client
            .request("fs/getMetadata", { path: `${path}/${entry.fileName}` })
            .catch(() => null);
          return {
            name: entry.fileName,
            path: `${path}/${entry.fileName}`,
            isDirectory: entry.isDirectory,
            modifiedAt: meta?.modifiedAtMs ? new Date(meta.modifiedAtMs).toISOString() : null,
          };
        }),
    );
    return { path, entries: detailed };
  }

  async read(file: string) {
    const path = safePath(file);
    const client = await this.ctx.codex.ready();
    try {
      const { dataBase64 } = await client.request("fs/readFile", { path });
      return { path, dataBase64 };
    } catch (error) {
      if (/no such file|not found/i.test(String(error)))
        throw new FileError(404, "That file isn't there anymore.");
      throw error;
    }
  }

  async write(file: string, dataBase64: string): Promise<void> {
    const path = safePath(file);
    const client = await this.ctx.codex.ready();
    await client.request("fs/writeFile", { path, dataBase64 });
  }

  /** Add a file to a folder under a name that isn't taken; returns where it went. */
  async put(folder: string, name: string, dataBase64: string): Promise<string> {
    const dir = safePath(folder);
    const client = await this.ctx.codex.ready();
    const { entries } = await client.request("fs/readDirectory", { path: dir });
    const taken = new Set(entries.map((entry) => entry.fileName));
    const path = `${dir}/${freeFileName(sanitizeFileName(name), taken)}`;
    await client.request("fs/writeFile", { path, dataBase64 });
    return path;
  }

  /** Remove a file or folder, except folders the system needs, like a teammate's workspace. */
  async remove(file: string): Promise<void> {
    const path = safePath(file);
    const active = await this.ctx.db
      .select({ slug: teammates.slug })
      .from(teammates)
      .where(isNull(teammates.archivedAt));
    const problem = undeletablePath(
      path,
      active.map((teammate) => teammate.slug),
    );
    if (problem) throw new FileError(403, problem);
    const client = await this.ctx.codex.ready();
    await client.request("fs/remove", { path, recursive: true });
  }
}
