import "server-only";
import type { ApiInputs, ApiOutputs, MemoryRunRef } from "@open-bot/api";
import { eq, inArray } from "drizzle-orm";
import { memoryContexts, memoryItems, runs } from "@open-bot/db";
import type { MemoryInput, MemoryItem, MemoryRevision } from "@open-bot/domain";
import { db } from "../db";
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
  const sources = runIds.length
    ? await db
        .select({ id: runs.id, teammateId: runs.botId, chatId: runs.chatId })
        .from(runs)
        .where(inArray(runs.id, runIds))
    : [];
  return items.map((item) => {
    const run = sources.find((r) => r.id === item.source.runId);
    return run
      ? { ...item, source: { ...item.source, botId: run.teammateId, chatId: run.chatId } }
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
    ? await db.select({ id: runs.id, chatId: runs.chatId }).from(runs).where(inArray(runs.id, ids))
    : [];
  return revisions.map((r) => {
    const chatId = sources.find((s) => s.id === r.source.runId)?.chatId;
    return chatId ? { ...r, source: { ...r.source, chatId } } : r;
  });
}

/** The memories a reply was given, and whether each still says the same. */
export async function memoriesForRun({
  runId,
}: ApiInputs["memory"]["forRun"]): Promise<MemoryRunRef[]> {
  await memoryReady();
  const [context] = await db
    .select({ refs: memoryContexts.refs })
    .from(memoryContexts)
    .where(eq(memoryContexts.runId, runId));
  const refs = context?.refs ?? [];
  const current = refs.length
    ? await db
        .select({
          id: memoryItems.id,
          content: memoryItems.content,
          revision: memoryItems.revision,
          state: memoryItems.state,
        })
        .from(memoryItems)
        .where(
          inArray(
            memoryItems.id,
            refs.map((ref) => ref.id),
          ),
        )
    : [];
  return refs.map((ref) => {
    const item = current.find((i) => i.id === ref.id);
    return {
      id: ref.id,
      revision: ref.revision,
      content: item?.state === "active" && item.revision === ref.revision ? item.content : null,
      changed: item?.revision !== ref.revision,
      forgotten: !item || item.state === "deleted",
    };
  });
}

/* ------------------------------------------------------------------ Your changes */

type Inputs = ApiInputs["memory"];
type Outputs = ApiOutputs["memory"];
const you = { kind: "user" } as const;

/** What the contract hands on, with its defaults filled in. */
type Edit = MemoryInput & { id: string; expectedRevision: number };

export async function createMemory(input: MemoryInput): Promise<Outputs["create"]> {
  return (await memoryReady()).save(input, you);
}

export async function updateMemory(input: Edit): Promise<Outputs["update"]> {
  return (await memoryReady()).update(input, you);
}

export async function forgetMemory(input: Inputs["forget"]): Promise<{ ok: true }> {
  await (await memoryReady()).forget(input, you);
  return { ok: true };
}

export async function confirmMemory(input: Inputs["confirm"]): Promise<Outputs["confirm"]> {
  return (await memoryReady()).approve(input);
}

export async function restoreMemory(input: Inputs["restore"]): Promise<Outputs["restore"]> {
  return (await memoryReady()).restore(input);
}
