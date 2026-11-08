import "server-only";
import type { ApiInputs, MemoryRunRef } from "@open-bot/api";
import type { MemoryItem, MemoryRevision } from "@open-bot/domain";
import { pool } from "../db";
import { memoryReady } from "../memory";

/** Memory as you see it in the app: what's saved, how it changed, and what a reply was given. */

/** The most memories one export holds. */
export const MEMORY_EXPORT_LIMIT = 10_000;

/**
 * Memories you can see, matching `query`: one teammate's, or everyone's with `botId` null. Each
 * names the teammate and chat that saved it, when a run did.
 */
export async function listMemories(
  { botId, query }: ApiInputs["memory"]["list"],
  limit = 200,
): Promise<MemoryItem[]> {
  const memory = await memoryReady();
  const items = await memory.list(
    { botId, candidates: true, includeExpired: true, limit, query },
    { kind: "user" },
  );
  const runIds = [...new Set(items.flatMap((i) => (i.source.runId ? [i.source.runId] : [])))];
  const runs = runIds.length
    ? await pool.query<{ id: string; bot_id: string; chat_id: string }>(
        "select id,bot_id,chat_id from runs where id=any($1::uuid[])",
        [runIds],
      )
    : { rows: [] };
  return items.map((item) => {
    const run = runs.rows.find((r) => r.id === item.source.runId);
    return run
      ? { ...item, source: { ...item.source, botId: run.bot_id, chatId: run.chat_id } }
      : item;
  });
}

/** Every revision of a memory, each with the chat that made it when a run did. */
export async function memoryHistory({
  memoryId,
}: ApiInputs["memory"]["history"]): Promise<MemoryRevision[]> {
  const memory = await memoryReady();
  const revisions = await memory.history(memoryId, { kind: "user" });
  const ids = revisions.flatMap((r) => (r.source.runId ? [r.source.runId] : []));
  const sources = ids.length
    ? await pool.query<{ id: string; chat_id: string }>(
        "select id,chat_id from runs where id=any($1::uuid[])",
        [ids],
      )
    : { rows: [] };
  return revisions.map((r) => {
    const chatId = sources.rows.find((s) => s.id === r.source.runId)?.chat_id;
    return chatId ? { ...r, source: { ...r.source, chatId } } : r;
  });
}

/** The memories a reply was given, and whether each still says the same. */
export async function memoriesForRun({
  runId,
}: ApiInputs["memory"]["forRun"]): Promise<MemoryRunRef[]> {
  await memoryReady();
  const { rows } = await pool.query<{ refs: { id: string; revision: number }[] }>(
    "select refs from memory_contexts where run_id=$1",
    [runId],
  );
  const refs = rows[0]?.refs ?? [];
  const current = refs.length
    ? await pool.query<{ id: string; content: string; revision: number; state: string }>(
        "select id,content,revision,state from memory_items where id=any($1::uuid[])",
        [refs.map((ref) => ref.id)],
      )
    : { rows: [] };
  return refs.map((ref) => {
    const item = current.rows.find((i) => i.id === ref.id);
    return {
      id: ref.id,
      revision: ref.revision,
      content: item?.state === "active" && item.revision === ref.revision ? item.content : null,
      changed: item?.revision !== ref.revision,
      forgotten: !item || item.state === "deleted",
    };
  });
}
