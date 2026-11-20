import { memoryItems, memoryJobs, memoryRevisions, type Tx } from "@open-bot/db";

type Row = typeof memoryItems.$inferSelect;

/** Records the row's current revision, and queues an embedding if it is active. */
export async function recordRevision(tx: Tx, row: Row): Promise<void> {
  await recordRevisions(tx, [row]);
}

/** Records each row's current revision in one statement, and queues embeddings for the active ones. */
export async function recordRevisions(tx: Tx, rows: readonly Row[]): Promise<void> {
  if (!rows.length) return;
  await tx.insert(memoryRevisions).values(
    rows.map((row) => {
      const { pinned, key, kind, expiresAt, state } = row;
      return {
        memoryId: row.id,
        revision: row.revision,
        content: row.content,
        snapshot: { pinned, key, kind, expiresAt: expiresAt?.toISOString() ?? null, state },
        source: row.source,
      };
    }),
  );
  const active = rows.filter((row) => row.state === "active");
  if (active.length)
    await tx
      .insert(memoryJobs)
      .values(
        active.map((row) => ({
          kind: "embed" as const,
          memoryId: row.id,
          revision: row.revision,
          dedupeKey: `embed:${row.id}:${row.revision}`,
        })),
      )
      .onConflictDoNothing({ target: memoryJobs.dedupeKey });
}
