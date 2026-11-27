// A save retried with the client id it was first sent with: the answer the first attempt got.
import { asc, eq } from "drizzle-orm";
import { memoryItems, memoryRevisions, type Tx } from "@open-bot/db";
import { fingerprint, itemView, MemoryError, type MemorySaveResult } from "./model";

/**
 * The memory an earlier save with client id `id` added, as that save's answer, or null when none
 * did. It is the memory as it is now, so an edit since shows. One forgotten since is refused,
 * saying so: answering with it would show a memory that's gone. An id naming a memory in another
 * scope, or one that started out saying something else, isn't a retry of this save.
 */
export async function savedAs(
  tx: Tx,
  id: string,
  teammateId: string | null,
  hash: string,
): Promise<MemorySaveResult | null> {
  const [row] = await tx.select().from(memoryItems).where(eq(memoryItems.id, id));
  if (!row) return null;
  const reused = () =>
    new MemoryError(409, "That memory id was already used for something else.", "reused-id");
  if (row.teammateId !== teammateId) throw reused();
  if (row.state === "deleted")
    throw new MemoryError(
      409,
      "This memory was saved, then forgotten before the answer came back. Add it again to keep it.",
    );
  // Forgetting removes revisions, so a memory that isn't forgotten still has its first one.
  const [first] = await tx
    .select({ content: memoryRevisions.content })
    .from(memoryRevisions)
    .where(eq(memoryRevisions.memoryId, id))
    .orderBy(asc(memoryRevisions.revision))
    .limit(1);
  if (first && fingerprint(first.content) !== hash) throw reused();
  return { ...itemView(row), saveOutcome: "created" };
}
