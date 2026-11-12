import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  bots as teammates,
  CHANNELS,
  lessons,
  LOCKS,
  lockUntilCommit,
  memoryEmbeddings,
  memoryGenerations,
  memoryImports,
  memoryItems,
  memoryJobs,
  memoryRevisions,
  ownerSettings,
  runs,
  settings,
  SETTINGS_ID,
  type Db,
  type Queryable,
  type Tx,
  type WorkerSignal,
} from "@open-bot/db";
import {
  memoryInputSchema,
  memoryEditSchema,
  memoryReferenceSchema,
  normalizeMemory,
  type AppEvent,
  type MemoryInput,
  type MemoryItem,
  type MemoryRevision,
  type MemorySource,
} from "@open-bot/domain";

export class MemoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type MemoryActor =
  | { kind: "user" }
  | { kind: "import" }
  | {
      kind: "bot";
      botId: string;
      runId: string;
      messageId?: string;
      verified?: boolean;
      allowShared?: boolean;
    };
export type MemorySaveResult = MemoryItem & {
  saveOutcome: "created" | "confirmed" | "unchanged";
};
type Row = typeof memoryItems.$inferSelect;
export function itemView(row: Row): MemoryItem {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    content: row.content,
    key: row.key,
    revision: row.revision,
    state: row.state,
    pinned: row.pinned,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function fingerprint(content: string): string {
  return createHash("sha256").update(normalizeMemory(content)).digest("hex");
}
function sourceOf(actor: MemoryActor): MemorySource {
  return actor.kind === "bot"
    ? {
        type: "bot",
        runId: actor.runId,
        ...(actor.messageId ? { messageId: actor.messageId } : {}),
      }
    : { type: actor.kind === "import" ? "import" : "user" };
}
function canRead(actor: MemoryActor, teammateId: string | null): boolean {
  return actor.kind !== "bot" || teammateId === null || teammateId === actor.botId;
}
function canWrite(actor: MemoryActor, teammateId: string | null): boolean {
  return (
    actor.kind !== "bot" ||
    teammateId === actor.botId ||
    (teammateId === null && (actor.verified === true || actor.allowShared === true))
  );
}
function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new MemoryError(400, result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}
/** A lesson a teammate file carried: any length the file allows, up to a memory's longest. */
const IMPORTED_LESSON = z.string().trim().min(1).max(8000);

const scopeOf = (teammateId: string | null) =>
  teammateId ? (`bot:${teammateId}` as const) : ("shared" as const);

const now = () => sql<Date>`now()`;
/** One scope's memories: a teammate's, or the shared ones (`null`). */
const inScope = (teammateId: string | null) =>
  teammateId ? eq(memoryItems.botId, teammateId) : isNull(memoryItems.botId);
/** A teammate's memories and the shared ones, which it reads too. */
const visibleTo = (teammateId: string) =>
  or(eq(memoryItems.botId, teammateId), isNull(memoryItems.botId));
const unexpired = () => or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, now()));
/** Content and key as one document. The `memory_items_search` index is on this exact expression. */
const document = () =>
  sql`to_tsvector('english', ${memoryItems.content} || ' ' || regexp_replace(coalesce(${memoryItems.key}, ''), '[^[:alnum:]]+', ' ', 'g'))`;
/** `text` matched literally by `ilike`: its `%`, `_` and `\` aren't wildcards. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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

/** Canonical memory. Both web actions and agent tools use these transactions. */
export class MemoryService {
  constructor(readonly db: Db) {}

  private async lockScope(tx: Tx, teammateId: string | null) {
    await lockUntilCommit(tx, LOCKS.memory(scopeOf(teammateId)));
    if (teammateId) {
      const [teammate] = await tx
        .select({ id: teammates.id })
        .from(teammates)
        .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
      if (!teammate) throw new MemoryError(404, "That teammate no longer exists.");
    }
  }

  private async revision(tx: Tx, row: Row) {
    const { pinned, key, kind, expiresAt, state } = row;
    await tx.insert(memoryRevisions).values({
      memoryId: row.id,
      revision: row.revision,
      content: row.content,
      snapshot: { pinned, key, kind, expiresAt: expiresAt?.toISOString() ?? null, state },
      source: row.source,
    });
    if (row.state === "active")
      await tx
        .insert(memoryJobs)
        .values({
          kind: "embed",
          memoryId: row.id,
          revision: row.revision,
          dedupeKey: `embed:${row.id}:${row.revision}`,
        })
        .onConflictDoNothing({ target: memoryJobs.dedupeKey });
  }

  /** Legacy tables are compatibility views maintained transactionally, never independent writers. */
  private async changed(
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
            teammateId ? eq(runs.botId, teammateId) : undefined,
            actor.kind === "bot" ? ne(runs.id, actor.runId) : undefined,
          ),
        );
      const cancel: WorkerSignal = "cancel";
      await tx.execute(sql`select pg_notify(${CHANNELS.worker}, ${cancel})`);
    }
    if (teammateId) {
      await tx.delete(lessons).where(eq(lessons.botId, teammateId));
      await tx.insert(lessons).select(
        tx
          .select({
            id: memoryItems.id,
            botId: sql<string>`${memoryItems.botId}`.as("bot_id"),
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
              eq(memoryItems.botId, teammateId),
              eq(memoryItems.kind, "lesson"),
              eq(memoryItems.state, "active"),
              unexpired(),
            ),
          ),
      );
      // SQL text, not `update(teammates)`: Drizzle would also bump `updated_at`, and a projection
      // changes only its own column.
      await tx.execute(
        sql`update ${teammates} set lessons_changed_at = now() where ${teammates.id} = ${teammateId}`,
      );
    } else {
      const rows = await tx
        .select({ content: memoryItems.content })
        .from(memoryItems)
        .where(and(isNull(memoryItems.botId), eq(memoryItems.state, "active"), unexpired()))
        .orderBy(asc(memoryItems.createdAt), asc(memoryItems.id));
      // Keep the old profile API bounded without imposing its old size limit on canonical memory.
      const profile = rows
        .map((r) => r.content)
        .join("\n")
        .slice(0, 8000);
      // SQL text for the same reason: only the profile's columns change.
      await tx.execute(
        sql`insert into ${settings} (id, about_me, about_me_updated_at) values (${SETTINGS_ID}, ${profile}, now())
        on conflict (id) do update set about_me = excluded.about_me, about_me_updated_at = now()`,
      );
    }
    for (const type of ["memory", "profile", "lessons"] as const) {
      const event: AppEvent = { type };
      await tx.execute(sql`select pg_notify(${CHANNELS.app}, ${JSON.stringify(event)})`);
    }
  }

  async save(
    input: MemoryInput,
    actor: MemoryActor,
    options: { source?: MemorySource; legacyKey?: string; id?: string } = {},
  ): Promise<MemorySaveResult> {
    const data = validate(memoryInputSchema, input);
    if (!canWrite(actor, data.botId))
      throw new MemoryError(
        403,
        "You can only save your own memories. Shared facts need an explicit user statement.",
      );
    if (data.expiresAt && new Date(data.expiresAt) <= new Date())
      throw new MemoryError(400, "Choose a future expiry.");
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, data.botId);
      const hash = fingerprint(data.content);
      if (actor.kind === "bot") {
        const blocked = await tx
          .select({ key: memoryImports.key })
          .from(memoryImports)
          .where(
            inArray(memoryImports.key, [
              `forgotten:${scopeOf(data.botId)}:${hash}`,
              ...(actor.messageId ? [`forget-source:${actor.messageId}`] : []),
            ]),
          );
        if (blocked.length && !actor.verified)
          throw new MemoryError(409, "This source or memory was forgotten. Do not learn it again.");
      }
      const [known] = await tx
        .select()
        .from(memoryItems)
        .where(and(inScope(data.botId), eq(memoryItems.fingerprint, hash)))
        .orderBy(asc(sql`${memoryItems.state} = 'deleted'`))
        .limit(1);
      if (known && known.state !== "deleted") {
        if (known.state === "candidate" && (actor.kind !== "bot" || actor.verified)) {
          if (data.key) {
            const conflict = await tx
              .select({ id: memoryItems.id })
              .from(memoryItems)
              .where(
                and(
                  inScope(known.botId),
                  eq(memoryItems.key, data.key),
                  eq(memoryItems.state, "active"),
                  ne(memoryItems.id, known.id),
                ),
              );
            if (conflict.length)
              throw new MemoryError(
                409,
                "This suggestion conflicts with a confirmed memory. Edit that memory instead.",
              );
          }
          const [row] = await tx
            .update(memoryItems)
            .set({
              state: "active",
              revision: sql`${memoryItems.revision} + 1`,
              source: options.source ?? sourceOf(actor),
              updatedAt: now(),
              content: data.content,
              kind: data.kind,
              key: data.key,
              pinned: actor.kind === "bot" ? false : data.pinned,
              expiresAt,
            })
            .where(eq(memoryItems.id, known.id))
            .returning();
          await this.revision(tx, row!);
          await this.changed(tx, known.botId, actor, true);
          return { ...itemView(row!), saveOutcome: "confirmed" };
        }
        return { ...itemView(known), saveOutcome: "unchanged" };
      }
      if (known && actor.kind === "bot" && !actor.verified)
        throw new MemoryError(
          409,
          "This memory was forgotten. Do not save it again from old context.",
        );
      if (data.key) {
        const clash = await tx
          .select({ id: memoryItems.id })
          .from(memoryItems)
          .where(
            and(
              inScope(data.botId),
              eq(memoryItems.key, data.key),
              eq(memoryItems.state, "active"),
            ),
          );
        if (clash.length)
          throw new MemoryError(
            409,
            "A memory with this key exists. Recall it and update its expected revision instead.",
          );
      }
      const state = actor.kind === "bot" && !actor.verified ? "candidate" : "active";
      const [row] = await tx
        .insert(memoryItems)
        .values({
          id: options.id ?? randomUUID(),
          botId: data.botId,
          kind: data.kind,
          content: data.content,
          key: data.key,
          fingerprint: hash,
          state,
          pinned: actor.kind === "bot" ? false : data.pinned,
          expiresAt,
          source: options.source ?? sourceOf(actor),
          legacyKey: options.legacyKey ?? null,
        })
        .returning();
      await this.revision(tx, row!);
      await this.changed(tx, data.botId, actor, state === "active");
      return { ...itemView(row!), saveOutcome: "created" };
    });
  }

  private async getLocked(tx: Tx, id: string, actor: MemoryActor): Promise<Row> {
    // Scope lock is acquired before the row lock by every writer, avoiding lock-order inversions.
    const [first] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id));
    if (!first || !canRead(actor, first.botId)) throw new MemoryError(404, "Memory not found.");
    await this.lockScope(tx, first.botId);
    const [row] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id)).for("update");
    if (!row || row.state === "deleted") throw new MemoryError(404, "Memory not found.");
    if (!canWrite(actor, row.botId))
      throw new MemoryError(403, "Only the user can change this shared memory.");
    return row;
  }

  async update(
    input: z.infer<typeof memoryEditSchema>,
    actor: MemoryActor,
    options: { allowExpired?: boolean } = {},
  ): Promise<MemoryItem> {
    const data = validate(memoryEditSchema, input);
    return this.db.transaction(async (tx) => {
      const old = await this.getLocked(tx, data.id, actor);
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it before saving.");
      if (old.botId !== data.botId)
        throw new MemoryError(400, "Scope cannot be changed. Save a separate memory instead.");
      if (actor.kind === "bot" && !actor.verified && old.state === "active")
        throw new MemoryError(
          403,
          "An inference cannot replace a confirmed memory. Suggest a new candidate.",
        );
      if (!options.allowExpired && data.expiresAt && new Date(data.expiresAt) <= new Date())
        throw new MemoryError(400, "Choose a future expiry.");
      const hash = fingerprint(data.content);
      const clashes = await tx
        .select({ id: memoryItems.id })
        .from(memoryItems)
        .where(
          and(
            inScope(old.botId),
            ne(memoryItems.id, old.id),
            ne(memoryItems.state, "deleted"),
            or(
              eq(memoryItems.fingerprint, hash),
              data.key
                ? and(eq(memoryItems.key, data.key), eq(memoryItems.state, "active"))
                : undefined,
            ),
          ),
        );
      if (clashes.length)
        throw new MemoryError(409, "Another memory already has this content or key.");
      const [row] = await tx
        .update(memoryItems)
        .set({
          content: data.content,
          kind: data.kind,
          key: data.key,
          fingerprint: hash,
          pinned: data.pinned,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          revision: sql`${memoryItems.revision} + 1`,
          updatedAt: now(),
          source: sourceOf(actor),
        })
        .where(eq(memoryItems.id, old.id))
        .returning();
      await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, old.id));
      await this.revision(tx, row!);
      await this.changed(tx, old.botId, actor, old.state === "active");
      return itemView(row!);
    });
  }

  async approve(input: z.infer<typeof memoryReferenceSchema>): Promise<MemoryItem> {
    const data = validate(memoryReferenceSchema, input);
    return this.db.transaction(async (tx) => {
      const old = await this.getLocked(tx, data.id, { kind: "user" });
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it first.");
      if (old.state !== "candidate")
        throw new MemoryError(409, "This memory is already confirmed.");
      if (old.expiresAt && old.expiresAt <= new Date())
        throw new MemoryError(409, "This suggestion expired.");
      if (old.key) {
        const clash = await tx
          .select({ id: memoryItems.id })
          .from(memoryItems)
          .where(
            and(
              inScope(old.botId),
              eq(memoryItems.key, old.key),
              eq(memoryItems.state, "active"),
              ne(memoryItems.id, old.id),
            ),
          );
        if (clash.length)
          throw new MemoryError(
            409,
            "This conflicts with a confirmed memory. Edit that memory instead.",
          );
      }
      const [row] = await tx
        .update(memoryItems)
        .set({ state: "active", revision: sql`${memoryItems.revision} + 1`, updatedAt: now() })
        .where(eq(memoryItems.id, old.id))
        .returning();
      await this.revision(tx, row!);
      await this.changed(tx, old.botId, { kind: "user" }, true);
      return itemView(row!);
    });
  }

  async forget(input: z.infer<typeof memoryReferenceSchema>, actor: MemoryActor): Promise<void> {
    const data = validate(memoryReferenceSchema, input);
    await this.db.transaction(async (tx) => {
      const old = await this.getLocked(tx, data.id, actor);
      if (actor.kind === "bot" && !actor.verified)
        throw new MemoryError(403, "Only forget memory when the user explicitly asks.");
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it before forgetting.");
      const previous = await tx
        .select({ content: memoryRevisions.content, source: memoryRevisions.source })
        .from(memoryRevisions)
        .where(eq(memoryRevisions.memoryId, old.id));
      for (const revision of previous) {
        await tx
          .insert(memoryImports)
          .values({ key: `forgotten:${scopeOf(old.botId)}:${fingerprint(revision.content)}` })
          .onConflictDoNothing();
        if (revision.source.messageId)
          await tx
            .insert(memoryImports)
            .values({ key: `forget-source:${revision.source.messageId}` })
            .onConflictDoNothing();
      }
      await tx
        .update(memoryItems)
        .set({
          content: "",
          key: null,
          state: "deleted",
          // A tombstone keeps no trace of who said it.
          source: sql`'{}'::jsonb`,
          revision: sql`${memoryItems.revision} + 1`,
          pinned: false,
          expiresAt: null,
          updatedAt: now(),
        })
        .where(eq(memoryItems.id, old.id));
      await tx.delete(memoryRevisions).where(eq(memoryRevisions.memoryId, old.id));
      await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, old.id));
      await tx.delete(memoryJobs).where(eq(memoryJobs.memoryId, old.id));
      await this.changed(tx, old.botId, actor, old.state === "active");
    });
  }

  /** Duplicate all confirmed, unexpired bot notes, without copying shared facts or private history. */
  async copyBot(fromBotId: string, toBotId: string): Promise<void> {
    validate(z.string().uuid(), fromBotId);
    validate(z.string().uuid(), toBotId);
    if (fromBotId === toBotId)
      throw new MemoryError(400, "Choose a different teammate for the copy.");
    await this.db.transaction(async (tx) => {
      for (const id of [fromBotId, toBotId].sort()) await this.lockScope(tx, id);
      const source = await tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.botId, fromBotId),
            eq(memoryItems.state, "active"),
            ne(memoryItems.kind, "lesson"),
            unexpired(),
          ),
        )
        .orderBy(asc(memoryItems.createdAt), asc(memoryItems.id));
      let changed = false;
      for (const copied of source) {
        if (await this.has(tx, toBotId, copied.fingerprint)) continue;
        const [row] = await tx
          .insert(memoryItems)
          .values({
            botId: toBotId,
            kind: copied.kind,
            content: copied.content,
            key: copied.key,
            fingerprint: copied.fingerprint,
            pinned: copied.pinned,
            expiresAt: copied.expiresAt,
            source: { type: "import" },
          })
          .returning();
        await this.revision(tx, row!);
        changed = true;
      }
      if (changed) await this.changed(tx, toBotId, { kind: "user" }, true);
    });
  }

  /** Whether a teammate already has a live memory with this fingerprint. */
  private async has(tx: Tx, teammateId: string, hash: string): Promise<boolean> {
    const rows = await tx
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.botId, teammateId),
          eq(memoryItems.fingerprint, hash),
          ne(memoryItems.state, "deleted"),
        ),
      );
    return rows.length > 0;
  }

  /**
   * Gives a teammate lessons it learned elsewhere (an imported file, or the teammate it was copied
   * from), pinned as lessons always were. One it already has, or a blank one, is skipped. With
   * `within`, in the caller's transaction, so the lessons are saved if and only if the caller's
   * change is.
   */
  async addLessons(teammateId: string, lessons: readonly string[], within?: Tx): Promise<void> {
    validate(z.string().uuid(), teammateId);
    // What a teammate file allows, so no lesson it carried is lost, however short.
    const contents = lessons.flatMap((content) => {
      const parsed = IMPORTED_LESSON.safeParse(content);
      return parsed.success ? [parsed.data] : [];
    });
    if (contents.length === 0) return;
    const work = async (tx: Tx) => {
      await this.lockScope(tx, teammateId);
      let changed = false;
      for (const content of contents) {
        const hash = fingerprint(content);
        if (await this.has(tx, teammateId, hash)) continue;
        const [row] = await tx
          .insert(memoryItems)
          .values({
            botId: teammateId,
            kind: "lesson",
            content,
            fingerprint: hash,
            pinned: true,
            source: { type: "import" },
          })
          .returning();
        await this.revision(tx, row!);
        changed = true;
      }
      if (changed) await this.changed(tx, teammateId, { kind: "user" }, true);
    };
    await (within ? work(within) : this.db.transaction(work));
  }

  /** A memory that isn't forgotten, if `actor` may read it. */
  private async readable(db: Queryable, id: string, actor: MemoryActor): Promise<Row> {
    validate(z.string().uuid(), id);
    const [row] = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.id, id), ne(memoryItems.state, "deleted")));
    if (!row || !canRead(actor, row.botId)) throw new MemoryError(404, "Memory not found.");
    return row;
  }

  async get(id: string, actor: MemoryActor): Promise<MemoryItem> {
    return itemView(await this.readable(this.db, id, actor));
  }

  async history(id: string, actor: MemoryActor): Promise<MemoryRevision[]> {
    await this.readable(this.db, id, actor);
    const rows = await this.db
      .select()
      .from(memoryRevisions)
      .where(eq(memoryRevisions.memoryId, id))
      .orderBy(desc(memoryRevisions.revision));
    return rows.map((r) => ({
      revision: r.revision,
      content: r.content,
      state: r.snapshot.state,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async restore(input: {
    id: string;
    expectedRevision: number;
    revision: number;
  }): Promise<MemoryItem> {
    const revisions = await this.history(input.id, { kind: "user" });
    const target = revisions.find((r) => r.revision === input.revision);
    if (!target) throw new MemoryError(404, "That revision no longer exists.");
    const [row] = await this.db.select().from(memoryItems).where(eq(memoryItems.id, input.id));
    const current = itemView(row!);
    const [saved] = await this.db
      .select({ snapshot: memoryRevisions.snapshot })
      .from(memoryRevisions)
      .where(
        and(eq(memoryRevisions.memoryId, input.id), eq(memoryRevisions.revision, input.revision)),
      );
    if (!saved) throw new MemoryError(404, "That revision no longer exists.");
    const { kind, key, pinned, expiresAt } = saved.snapshot;
    return this.update(
      {
        ...current,
        kind,
        key,
        pinned,
        expiresAt,
        content: target.content,
        expectedRevision: input.expectedRevision,
      },
      { kind: "user" },
      { allowExpired: true },
    );
  }

  async list(
    options: {
      botId: string | null;
      includeShared?: boolean;
      query?: string;
      candidates?: boolean;
      includeExpired?: boolean;
      limit?: number;
    },
    actor: MemoryActor,
  ): Promise<MemoryItem[]> {
    if (options.botId) validate(z.string().uuid(), options.botId);
    if (!canRead(actor, options.botId)) throw new MemoryError(404, "Memory not found.");
    const query = (options.query ?? "").trim().slice(0, 500);
    const rows = await this.db
      .select()
      .from(memoryItems)
      .where(
        and(
          options.includeShared
            ? or(inScope(options.botId), isNull(memoryItems.botId))
            : inScope(options.botId),
          inArray(memoryItems.state, options.candidates ? ["active", "candidate"] : ["active"]),
          options.includeExpired ? undefined : unexpired(),
          query
            ? or(
                sql`${document()} @@ websearch_to_tsquery('english', ${query})`,
                ilike(memoryItems.content, containing(query)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(memoryItems.pinned), desc(memoryItems.updatedAt), asc(memoryItems.id))
      .limit(Math.max(1, Math.min(options.limit ?? 200, 10001)));
    return rows.map(itemView);
  }

  async generation(botId: string): Promise<string> {
    const rows = await this.db
      .select()
      .from(memoryGenerations)
      .where(inArray(memoryGenerations.scope, ["shared", scopeOf(botId)]));
    const [expired] = await this.db
      .select({ count: count() })
      .from(memoryItems)
      .where(
        and(visibleTo(botId), eq(memoryItems.state, "active"), lte(memoryItems.expiresAt, now())),
      );
    return `${rows.find((r) => r.scope === "shared")?.generation ?? 0}:${rows.find((r) => r.scope === scopeOf(botId))?.generation ?? 0}:${expired!.count}`;
  }

  async recall(
    botId: string,
    query: string,
    options: { vector?: number[]; model?: string; maxDistance?: number } = {},
  ): Promise<MemoryItem[]> {
    validate(z.string().uuid(), botId);
    // Any of the query's words, not all of them.
    const terms = sql`to_tsquery('english', replace(plainto_tsquery('english', ${query.slice(0, 1000)})::text, ' & ', ' | '))`;
    const lexical = await this.db
      .select(getTableColumns(memoryItems))
      .from(memoryItems)
      .where(
        and(
          visibleTo(botId),
          eq(memoryItems.state, "active"),
          unexpired(),
          or(memoryItems.pinned, sql`${document()} @@ ${terms}`),
        ),
      )
      .orderBy(
        desc(memoryItems.pinned),
        desc(sql`ts_rank_cd(${document()}, ${terms})`),
        desc(memoryItems.updatedAt),
        asc(memoryItems.id),
      )
      .limit(30);
    let semantic: Row[] = [];
    if (options.vector?.length && options.model) {
      const embedding = memoryEmbeddings.embedding;
      const distance = sql`(${embedding} <=> ${JSON.stringify(options.vector)}::vector)`;
      semantic = await this.db
        .select(getTableColumns(memoryItems))
        .from(memoryItems)
        .innerJoin(
          memoryEmbeddings,
          and(
            eq(memoryEmbeddings.memoryId, memoryItems.id),
            eq(memoryEmbeddings.revision, memoryItems.revision),
          ),
        )
        .where(
          and(
            visibleTo(botId),
            eq(memoryItems.state, "active"),
            unexpired(),
            eq(memoryEmbeddings.model, options.model),
            sql`vector_dims(${embedding}) = ${options.vector.length}`,
            sql`${distance} <= ${options.maxDistance ?? 0.4}`,
          ),
        )
        .orderBy(distance)
        .limit(30);
    }
    const scores = new Map<string, { row: Row; score: number }>();
    for (const list of [lexical, semantic])
      list.forEach((row, i) => {
        const previous = scores.get(row.id);
        scores.set(row.id, { row, score: (previous?.score ?? 0) + 1 / (60 + i + 1) });
      });
    // Do not fill empty recall with unrelated recent facts. The caller can explicitly list its memory.
    return [...scores.values()]
      .sort(
        (a, b) =>
          Number(b.row.pinned) - Number(a.row.pinned) ||
          b.score - a.score ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, 12)
      .map(({ row }) => itemView(row));
  }

  /** Import legacy sources once. Tombstones keep legacy keys, so forgotten content never returns. */
  async importLegacy(): Promise<void> {
    const profile = await ownerSettings(this.db);
    await this.importOnce("legacy:profile", null, profile?.aboutMe ?? "", "note", true);
    const legacy = await this.db
      .select({
        id: lessons.id,
        botId: lessons.botId,
        text: lessons.text,
        runId: lessons.runId,
      })
      .from(lessons)
      .innerJoin(teammates, eq(teammates.id, lessons.botId))
      .where(isNull(teammates.archivedAt));
    for (const lesson of legacy)
      await this.importOnce(
        `legacy:lesson:${lesson.id}`,
        lesson.botId,
        lesson.text,
        "lesson",
        true,
        lesson.id,
        lesson.runId ? { type: "feedback", runId: lesson.runId } : { type: "import" },
      );
  }

  async importOnce(
    key: string,
    botId: string | null,
    content: string,
    kind: MemoryInput["kind"] = "note",
    pinned = false,
    id?: string,
    source?: MemorySource,
  ): Promise<void> {
    const done = await this.db
      .select({ key: memoryImports.key })
      .from(memoryImports)
      .where(eq(memoryImports.key, key));
    if (done.length) return;
    // Import into one scope transaction through a dedicated lock, then mark even empty sources.
    await this.db.transaction(async (tx) => {
      await this.lockScope(tx, botId);
      const claimed = await tx
        .insert(memoryImports)
        .values({ key })
        .onConflictDoNothing()
        .returning({ key: memoryImports.key });
      if (!claimed.length || !content.trim()) return;
      const hash = fingerprint(content);
      const existing = await tx
        .select({ id: memoryItems.id })
        .from(memoryItems)
        .where(
          or(
            eq(memoryItems.legacyKey, key),
            and(inScope(botId), eq(memoryItems.fingerprint, hash)),
          ),
        );
      if (existing.length) return;
      const [row] = await tx
        .insert(memoryItems)
        .values({
          id: id ?? randomUUID(),
          botId,
          kind,
          content,
          fingerprint: hash,
          pinned,
          source: source ?? { type: "import" },
          legacyKey: key,
        })
        .returning();
      await this.revision(tx, row!);
      // Importing a batch must not erase other legacy rows before they are imported.
      await bumpGeneration(tx, botId);
    });
  }

  async queueExtraction(runId: string): Promise<void> {
    await this.db
      .insert(memoryJobs)
      .values({ kind: "extract", runId, dedupeKey: `extract:${runId}` })
      .onConflictDoNothing({ target: memoryJobs.dedupeKey });
  }
}
