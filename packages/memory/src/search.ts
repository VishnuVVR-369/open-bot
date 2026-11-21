// Reading memory in bulk: the list the UI and tools show, recall for a run (full text plus
// optional vectors), and the generation a run compares to notice that its memory changed.
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { memoryEmbeddings, memoryGenerations, memoryItems, type Db } from "@open-bot/db";
import type { MemoryItem } from "@open-bot/domain";
import { canRead, itemView, MemoryError, type MemoryActor, type Row, validate } from "./model";
import { containing, document, inScope, now, scopeOf, unexpired, visibleTo } from "./queries";

export type MemoryListOptions = {
  teammateId: string | null;
  includeShared?: boolean;
  query?: string;
  candidates?: boolean;
  includeExpired?: boolean;
  limit?: number;
};

export type RecallOptions = { vector?: number[]; model?: string; maxDistance?: number };

export async function listMemories(
  db: Db,
  options: MemoryListOptions,
  actor: MemoryActor,
): Promise<MemoryItem[]> {
  if (options.teammateId) validate(z.string().uuid(), options.teammateId);
  if (!canRead(actor, options.teammateId)) throw new MemoryError(404, "Memory not found.");
  const query = (options.query ?? "").trim().slice(0, 500);
  const rows = await db
    .select()
    .from(memoryItems)
    .where(
      and(
        options.includeShared
          ? or(inScope(options.teammateId), isNull(memoryItems.teammateId))
          : inScope(options.teammateId),
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

export async function memoryGeneration(db: Db, teammateId: string): Promise<string> {
  const rows = await db
    .select()
    .from(memoryGenerations)
    .where(inArray(memoryGenerations.scope, ["shared", scopeOf(teammateId)]));
  const [expired] = await db
    .select({ count: count() })
    .from(memoryItems)
    .where(
      and(
        visibleTo(teammateId),
        eq(memoryItems.state, "active"),
        lte(memoryItems.expiresAt, now()),
      ),
    );
  return `${rows.find((r) => r.scope === "shared")?.generation ?? 0}:${rows.find((r) => r.scope === scopeOf(teammateId))?.generation ?? 0}:${expired!.count}`;
}

export async function recallMemories(
  db: Db,
  teammateId: string,
  query: string,
  options: RecallOptions = {},
): Promise<MemoryItem[]> {
  validate(z.string().uuid(), teammateId);
  // Any of the query's words, not all of them.
  const terms = sql`to_tsquery('english', replace(plainto_tsquery('english', ${query.slice(0, 1000)})::text, ' & ', ' | '))`;
  const lexical = await db
    .select(getTableColumns(memoryItems))
    .from(memoryItems)
    .where(
      and(
        visibleTo(teammateId),
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
    semantic = await db
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
          visibleTo(teammateId),
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
