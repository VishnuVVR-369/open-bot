import "server-only";
import type { ApiInputs, ApiOutputs, MemoryRunRef } from "@open-bot/api";
import { eq, inArray } from "drizzle-orm";
import { memoryContexts, memoryItems, runs } from "@open-bot/db";
import {
  MEMORY_LIST_LIMIT,
  type MemoryInput,
  type MemoryItem,
  type MemoryRevision,
} from "@open-bot/domain";
import { db } from "@/lib/server/db";
import { memory } from "./store";

/** Memory as you see it in the app: what's saved, how it changed, and what a reply was given. */

/** The most memories one export holds. */
export const MEMORY_EXPORT_LIMIT = 10_000;

/**
 * Memories you can see, matching `query`: one teammate's, or everyone's with `teammateId` null. Each
 * names the teammate and chat that saved it, when a run did.
 */
export async function listMemories(
  { teammateId, query }: ApiInputs["memory"]["list"],
  limit = MEMORY_LIST_LIMIT,
): Promise<MemoryItem[]> {
  return withSources(
    await memory.list(
      { teammateId, candidates: true, includeExpired: true, limit, query },
      { kind: "user" },
    ),
  );
}

/** One memory you can see, named by the teammate and chat that saved it, like the list. */
export async function getMemory({ memoryId }: ApiInputs["memory"]["get"]): Promise<MemoryItem> {
  const [item] = await withSources([await memory.get(memoryId, { kind: "user" })]);
  return item!;
}

/** Memories with the teammate and chat of the run that saved each, when one did. */
async function withSources<T extends MemoryItem>(items: T[]): Promise<T[]> {
  const runIds = [...new Set(items.flatMap((i) => (i.source.runId ? [i.source.runId] : [])))];
  const sources = runIds.length
    ? await db
        .select({ id: runs.id, teammateId: runs.teammateId, chatId: runs.chatId })
        .from(runs)
        .where(inArray(runs.id, runIds))
    : [];
  return items.map((item) => {
    const run = sources.find((r) => r.id === item.source.runId);
    return run
      ? { ...item, source: { ...item.source, teammateId: run.teammateId, chatId: run.chatId } }
      : item;
  });
}

/** Every revision of a memory, each with the chat that made it when a run did. */
export async function memoryHistory({
  memoryId,
}: ApiInputs["memory"]["history"]): Promise<MemoryRevision[]> {
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

/**
 * A memory a change answered with, named by the teammate and chat that saved it like a read, so a
 * client can show the answer in place of what it read.
 */
async function withSource<T extends MemoryItem>(item: T): Promise<T> {
  const [named] = await withSources([item]);
  return named!;
}

/** Saves a memory you wrote, under the client's `id` when it sent one (see `contract.memory.create`). */
export async function createMemory({
  id,
  ...input
}: MemoryInput & { id?: string }): Promise<Outputs["create"]> {
  return withSource(await memory.save(input, you, id ? { id } : {}));
}

export async function updateMemory(input: Edit): Promise<Outputs["update"]> {
  return withSource(await memory.update(input, you));
}

export async function forgetMemory(input: Inputs["forget"]): Promise<{ ok: true }> {
  await memory.forget(input, you);
  return { ok: true };
}

export async function confirmMemory(input: Inputs["confirm"]): Promise<Outputs["confirm"]> {
  return withSource(await memory.approve(input));
}

export async function restoreMemory(input: Inputs["restore"]): Promise<Outputs["restore"]> {
  return withSource(await memory.restore(input));
}
