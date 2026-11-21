// The protocol every memory write follows: lock the scope (then the row), and after the change
// rebuild in the same transaction what depends on it (generations, stale runs, lessons, profile).
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  teammates,
  lessons,
  LOCKS,
  lockUntilCommit,
  memoryGenerations,
  memoryItems,
  runs,
  settings,
  SETTINGS_ID,
  type Tx,
} from "@open-bot/db";
import { type AppEvent, NOTIFY_CHANNELS, type WorkerSignal } from "@open-bot/domain";
import { canRead, canWrite, MemoryError, type MemoryActor, type Row } from "./model";
import { now, scopeOf, unexpired } from "./queries";

/** Tells runs that read this scope's memory that it changed. */
async function bumpGeneration(tx: Tx, teammateId: string | null) {
  await tx
    .insert(memoryGenerations)
    .values({ scope: scopeOf(teammateId), generation: 1 })
    .onConflictDoUpdate({
      target: memoryGenerations.scope,
      set: { generation: sql`${memoryGenerations.generation} + 1` },
    });
}

export async function lockScope(tx: Tx, teammateId: string | null) {
  await lockUntilCommit(tx, LOCKS.memory(scopeOf(teammateId)));
  if (teammateId) {
    const [teammate] = await tx
      .select({ id: teammates.id })
      .from(teammates)
      .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
    if (!teammate) throw new MemoryError(404, "That teammate no longer exists.");
  }
}

export async function getLocked(tx: Tx, id: string, actor: MemoryActor): Promise<Row> {
  // Scope lock is acquired before the row lock by every writer, avoiding lock-order inversions.
  const [first] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id));
  if (!first || !canRead(actor, first.teammateId)) throw new MemoryError(404, "Memory not found.");
  await lockScope(tx, first.teammateId);
  const [row] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id)).for("update");
  if (!row || row.state === "deleted") throw new MemoryError(404, "Memory not found.");
  if (!canWrite(actor, row.teammateId))
    throw new MemoryError(403, "Only the user can change this shared memory.");
  return row;
}

/** Legacy tables are compatibility views maintained transactionally, never independent writers. */
export async function recordChange(
  tx: Tx,
  teammateId: string | null,
  actor: MemoryActor,
  contextChanged: boolean,
) {
  if (contextChanged) {
    await bumpGeneration(tx, teammateId);
    // Mark stale active turns durably. The worker also receives a wakeup, including across processes.
    await tx
      .update(runs)
      .set({ cancelRequestedAt: now() })
      .where(
        and(
          inArray(runs.status, ["starting", "running", "waiting"]),
          teammateId ? eq(runs.teammateId, teammateId) : undefined,
          actor.kind === "teammate" ? ne(runs.id, actor.runId) : undefined,
        ),
      );
    const cancel: WorkerSignal = "cancel";
    await tx.execute(sql`select pg_notify(${NOTIFY_CHANNELS.worker}, ${cancel})`);
  }
  if (teammateId) {
    await tx.delete(lessons).where(eq(lessons.teammateId, teammateId));
    await tx.insert(lessons).select(
      tx
        .select({
          id: memoryItems.id,
          teammateId: sql<string>`${memoryItems.teammateId}`.as("teammate_id"),
          runId: sql<
            string | null
          >`(select ${runs.id} from ${runs} where ${runs.id}::text = ${memoryItems.source}->>'runId')`.as(
            "run_id",
          ),
          text: memoryItems.content,
          createdAt: memoryItems.createdAt,
        })
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.teammateId, teammateId),
            eq(memoryItems.kind, "lesson"),
            eq(memoryItems.state, "active"),
            unexpired(),
          ),
        ),
    );
    // SQL text, not `update(teammates)`: Drizzle would also bump `updated_at`, and a projection
    // changes only its own column. Column names come from the schema, which the table-owners
    // lint reads.
    await tx.execute(
      sql`update ${teammates} set ${sql.identifier(teammates.lessonsChangedAt.name)} = now()
      where ${teammates.id} = ${teammateId}`,
    );
  } else {
    const rows = await tx
      .select({ content: memoryItems.content })
      .from(memoryItems)
      .where(and(isNull(memoryItems.teammateId), eq(memoryItems.state, "active"), unexpired()))
      .orderBy(asc(memoryItems.createdAt), asc(memoryItems.id));
    // Keep the old profile API bounded without imposing its old size limit on canonical memory.
    const profile = rows
      .map((r) => r.content)
      .join("\n")
      .slice(0, 8000);
    // SQL text for the same reason: only the profile's columns change.
    await tx.execute(
      sql`insert into ${settings} (${sql.identifier(settings.id.name)}, ${sql.identifier(settings.aboutMe.name)}, ${sql.identifier(settings.aboutMeUpdatedAt.name)})
      values (${SETTINGS_ID}, ${profile}, now())
      on conflict (${sql.identifier(settings.id.name)}) do update
      set ${sql.identifier(settings.aboutMe.name)} = excluded.${sql.identifier(settings.aboutMe.name)},
        ${sql.identifier(settings.aboutMeUpdatedAt.name)} = now()`,
    );
  }
  for (const type of ["memory", "profile", "lessons"] as const) {
    const event: AppEvent = { type };
    await tx.execute(sql`select pg_notify(${NOTIFY_CHANNELS.app}, ${JSON.stringify(event)})`);
  }
}
