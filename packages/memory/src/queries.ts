// SQL fragments every memory query shares: scopes, visibility, expiry and the search document.
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { memoryItems, type Queryable } from "@open-bot/db";
import { canRead, MemoryError, type MemoryActor, type Row, validate } from "./model";

export const scopeOf = (teammateId: string | null) =>
  teammateId ? (`teammate:${teammateId}` as const) : ("shared" as const);

export const now = () => sql<Date>`now()`;
/** One scope's memories: a teammate's, or the shared ones (`null`). */
export const inScope = (teammateId: string | null) =>
  teammateId ? eq(memoryItems.teammateId, teammateId) : isNull(memoryItems.teammateId);
/** A teammate's memories and the shared ones, which it reads too. */
export const visibleTo = (teammateId: string) =>
  or(eq(memoryItems.teammateId, teammateId), isNull(memoryItems.teammateId));
export const unexpired = () => or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, now()));
/** Content and key as one document. The `memory_items_search` index is on this exact expression. */
export const document = () =>
  sql`to_tsvector('english', ${memoryItems.content} || ' ' || regexp_replace(coalesce(${memoryItems.key}, ''), '[^[:alnum:]]+', ' ', 'g'))`;
/** `text` matched literally by `ilike`: its `%`, `_` and `\` aren't wildcards. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A memory that isn't forgotten, if `actor` may read it. */
export async function readable(db: Queryable, id: string, actor: MemoryActor): Promise<Row> {
  validate(z.string().uuid(), id);
  const [row] = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.id, id), ne(memoryItems.state, "deleted")));
  if (!row || !canRead(actor, row.teammateId)) throw new MemoryError(404, "Memory not found.");
  return row;
}
