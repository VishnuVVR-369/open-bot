// Memories brought in from elsewhere: another teammate's notes, or the lessons a teammate file carried.
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { memoryItems, type Db, type Tx } from "@open-bot/db";
import { lockScope, recordChange } from "./changes";
import { fingerprint, MemoryError, validate } from "./model";
import { inScope, unexpired } from "./queries";
import { recordRevision, recordRevisions } from "./revisions";

/** A lesson a teammate file carried: any length the file allows, up to a memory's longest. */
const IMPORTED_LESSON = z.string().trim().min(1).max(8000);

/** Notes copied per statement: well under Postgres's limit of 65,535 parameters per query. */
const COPY_BATCH = 500;

/** Whether a teammate already has a live memory with this fingerprint. */
async function has(tx: Tx, teammateId: string, hash: string): Promise<boolean> {
  const rows = await tx
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.teammateId, teammateId),
        eq(memoryItems.fingerprint, hash),
        ne(memoryItems.state, "deleted"),
      ),
    );
  return rows.length > 0;
}

export async function copyTeammateMemory(
  db: Db,
  fromTeammateId: string,
  toTeammateId: string,
): Promise<void> {
  validate(z.string().uuid(), fromTeammateId);
  validate(z.string().uuid(), toTeammateId);
  if (fromTeammateId === toTeammateId)
    throw new MemoryError(400, "Choose a different teammate for the copy.");
  await db.transaction(async (tx) => {
    for (const id of [fromTeammateId, toTeammateId].sort()) await lockScope(tx, id);
    const source = await tx
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.teammateId, fromTeammateId),
          eq(memoryItems.state, "active"),
          ne(memoryItems.kind, "lesson"),
          unexpired(),
        ),
      )
      .orderBy(asc(memoryItems.createdAt), asc(memoryItems.id));
    // One statement per step, not per note, so a large copy holds both scopes' locks briefly.
    const held = new Set(
      (
        await tx
          .select({ fingerprint: memoryItems.fingerprint })
          .from(memoryItems)
          .where(and(inScope(toTeammateId), ne(memoryItems.state, "deleted")))
      ).map((row) => row.fingerprint),
    );
    const missing = source.filter((copied) => !held.has(copied.fingerprint));
    for (let start = 0; start < missing.length; start += COPY_BATCH) {
      const rows = await tx
        .insert(memoryItems)
        .values(
          missing.slice(start, start + COPY_BATCH).map((copied) => ({
            teammateId: toTeammateId,
            kind: copied.kind,
            content: copied.content,
            key: copied.key,
            fingerprint: copied.fingerprint,
            pinned: copied.pinned,
            expiresAt: copied.expiresAt,
            source: { type: "import" as const },
          })),
        )
        .returning();
      await recordRevisions(tx, rows);
    }
    const changed = missing.length > 0;
    if (changed) await recordChange(tx, toTeammateId, { kind: "user" }, true);
  });
}

export async function importLessons(
  db: Db,
  teammateId: string,
  lessons: readonly string[],
  within?: Tx,
): Promise<void> {
  validate(z.string().uuid(), teammateId);
  // What a teammate file allows, so no lesson it carried is lost, however short.
  const contents = lessons.flatMap((content) => {
    const parsed = IMPORTED_LESSON.safeParse(content);
    return parsed.success ? [parsed.data] : [];
  });
  if (contents.length === 0) return;
  const work = async (tx: Tx) => {
    await lockScope(tx, teammateId);
    let changed = false;
    for (const content of contents) {
      const hash = fingerprint(content);
      if (await has(tx, teammateId, hash)) continue;
      const [row] = await tx
        .insert(memoryItems)
        .values({
          teammateId,
          kind: "lesson",
          content,
          fingerprint: hash,
          pinned: true,
          source: { type: "import" },
        })
        .returning();
      await recordRevision(tx, row!);
      changed = true;
    }
    if (changed) await recordChange(tx, teammateId, { kind: "user" }, true);
  };
  await (within ? work(within) : db.transaction(work));
}
