// `MemoryService`, the one way into canonical memory: saving, editing, approving, forgetting and
// restoring a memory here, with searching in `search.ts`, copying and imported lessons in
// `transfer.ts`, and the lock-then-project protocol every write follows in `changes.ts`.
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  memoryEmbeddings,
  memoryImports,
  memoryItems,
  memoryJobs,
  memoryRevisions,
  type Db,
  type Tx,
} from "@open-bot/db";
import {
  memoryEditSchema,
  type MemoryInput,
  memoryInputSchema,
  type MemoryItem,
  memoryReferenceSchema,
  type MemoryRevision,
  type MemorySource,
} from "@open-bot/domain";
import { getLocked, lockScope, recordChange } from "./changes";
import {
  canWrite,
  fingerprint,
  guarded,
  itemView,
  MemoryError,
  type MemoryActor,
  type MemorySaveResult,
  sourceOf,
  validate,
} from "./model";
import { inScope, now, readable, scopeOf } from "./queries";
import { recordRevision } from "./revisions";
import {
  listMemories,
  memoryGeneration,
  type MemoryListOptions,
  recallMemories,
  type RecallOptions,
} from "./search";
import { copyTeammateMemory, importLessons } from "./transfer";

export {
  fingerprint,
  itemView,
  MemoryError,
  type MemoryActor,
  type MemorySaveResult,
} from "./model";

/** Canonical memory. Both web actions and agent tools use these transactions. */
export class MemoryService {
  constructor(readonly db: Db) {}

  async save(
    input: MemoryInput,
    actor: MemoryActor,
    options: { source?: MemorySource } = {},
  ): Promise<MemorySaveResult> {
    return guarded(async () => {
      const data = validate(memoryInputSchema, input);
      if (!canWrite(actor, data.teammateId))
        throw new MemoryError(
          403,
          "You can only save your own memories. Shared facts need an explicit user statement.",
        );
      if (data.expiresAt && new Date(data.expiresAt) <= new Date())
        throw new MemoryError(400, "Choose a future expiry.");
      const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
      return this.db.transaction(async (tx) => {
        await lockScope(tx, data.teammateId);
        const hash = fingerprint(data.content);
        if (actor.kind === "teammate") {
          const blocked = await tx
            .select({ key: memoryImports.key })
            .from(memoryImports)
            .where(
              inArray(memoryImports.key, [
                `forgotten:${scopeOf(data.teammateId)}:${hash}`,
                ...(actor.messageId ? [`forget-source:${actor.messageId}`] : []),
              ]),
            );
          if (blocked.length && !actor.verified)
            throw new MemoryError(
              409,
              "This source or memory was forgotten. Do not learn it again.",
            );
        }
        const [known] = await tx
          .select()
          .from(memoryItems)
          .where(and(inScope(data.teammateId), eq(memoryItems.fingerprint, hash)))
          .orderBy(asc(sql`${memoryItems.state} = 'deleted'`))
          .limit(1);
        if (known && known.state !== "deleted") {
          if (known.state === "candidate" && (actor.kind !== "teammate" || actor.verified)) {
            if (data.key) {
              const conflict = await tx
                .select({ id: memoryItems.id })
                .from(memoryItems)
                .where(
                  and(
                    inScope(known.teammateId),
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
                pinned: actor.kind === "teammate" ? false : data.pinned,
                expiresAt,
              })
              .where(eq(memoryItems.id, known.id))
              .returning();
            await recordRevision(tx, row!);
            await recordChange(tx, known.teammateId, actor, true);
            return { ...itemView(row!), saveOutcome: "confirmed" };
          }
          return { ...itemView(known), saveOutcome: "unchanged" };
        }
        if (known && actor.kind === "teammate" && !actor.verified)
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
                inScope(data.teammateId),
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
        const state = actor.kind === "teammate" && !actor.verified ? "candidate" : "active";
        const [row] = await tx
          .insert(memoryItems)
          .values({
            teammateId: data.teammateId,
            kind: data.kind,
            content: data.content,
            key: data.key,
            fingerprint: hash,
            state,
            pinned: actor.kind === "teammate" ? false : data.pinned,
            expiresAt,
            source: options.source ?? sourceOf(actor),
          })
          .returning();
        await recordRevision(tx, row!);
        await recordChange(tx, data.teammateId, actor, state === "active");
        return { ...itemView(row!), saveOutcome: "created" };
      });
    });
  }

  async update(
    input: z.infer<typeof memoryEditSchema>,
    actor: MemoryActor,
    options: { allowExpired?: boolean } = {},
  ): Promise<MemoryItem> {
    return guarded(async () => {
      const data = validate(memoryEditSchema, input);
      return this.db.transaction(async (tx) => {
        const old = await getLocked(tx, data.id, actor);
        if (old.revision !== data.expectedRevision)
          throw new MemoryError(409, "This memory changed. Reload it before saving.");
        if (old.teammateId !== data.teammateId)
          throw new MemoryError(400, "Scope cannot be changed. Save a separate memory instead.");
        if (actor.kind === "teammate" && !actor.verified && old.state === "active")
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
              inScope(old.teammateId),
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
        await recordRevision(tx, row!);
        await recordChange(tx, old.teammateId, actor, old.state === "active");
        return itemView(row!);
      });
    });
  }

  async approve(input: z.infer<typeof memoryReferenceSchema>): Promise<MemoryItem> {
    return guarded(async () => {
      const data = validate(memoryReferenceSchema, input);
      return this.db.transaction(async (tx) => {
        const old = await getLocked(tx, data.id, { kind: "user" });
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
                inScope(old.teammateId),
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
        await recordRevision(tx, row!);
        await recordChange(tx, old.teammateId, { kind: "user" }, true);
        return itemView(row!);
      });
    });
  }

  async forget(input: z.infer<typeof memoryReferenceSchema>, actor: MemoryActor): Promise<void> {
    return guarded(async () => {
      const data = validate(memoryReferenceSchema, input);
      await this.db.transaction(async (tx) => {
        const old = await getLocked(tx, data.id, actor);
        if (actor.kind === "teammate" && !actor.verified)
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
            .values({
              key: `forgotten:${scopeOf(old.teammateId)}:${fingerprint(revision.content)}`,
            })
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
        await recordChange(tx, old.teammateId, actor, old.state === "active");
      });
    });
  }

  /** Duplicate all confirmed, unexpired teammate notes, without copying shared facts or private history. */
  async copyTeammate(fromTeammateId: string, toTeammateId: string): Promise<void> {
    return guarded(() => copyTeammateMemory(this.db, fromTeammateId, toTeammateId));
  }

  /**
   * Gives a teammate lessons it learned elsewhere (an imported file, or the teammate it was copied
   * from), pinned as lessons always were. One it already has, or a blank one, is skipped. With
   * `within`, in the caller's transaction, so the lessons are saved if and only if the caller's
   * change is.
   */
  async addLessons(teammateId: string, lessons: readonly string[], within?: Tx): Promise<void> {
    return guarded(() => importLessons(this.db, teammateId, lessons, within));
  }

  async get(id: string, actor: MemoryActor): Promise<MemoryItem> {
    return guarded(async () => {
      return itemView(await readable(this.db, id, actor));
    });
  }

  async history(id: string, actor: MemoryActor): Promise<MemoryRevision[]> {
    return guarded(async () => {
      await readable(this.db, id, actor);
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
    });
  }

  async restore(input: {
    id: string;
    expectedRevision: number;
    revision: number;
  }): Promise<MemoryItem> {
    return guarded(async () => {
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
    });
  }

  async list(options: MemoryListOptions, actor: MemoryActor): Promise<MemoryItem[]> {
    return guarded(() => listMemories(this.db, options, actor));
  }

  async generation(teammateId: string): Promise<string> {
    return guarded(() => memoryGeneration(this.db, teammateId));
  }

  async recall(
    teammateId: string,
    query: string,
    options: RecallOptions = {},
  ): Promise<MemoryItem[]> {
    return guarded(() => recallMemories(this.db, teammateId, query, options));
  }

  async queueExtraction(runId: string): Promise<void> {
    return guarded(async () => {
      await this.db
        .insert(memoryJobs)
        .values({ kind: "extract", runId, dedupeKey: `extract:${runId}` })
        .onConflictDoNothing({ target: memoryJobs.dedupeKey });
    });
  }
}
