// What memory hands out (`MemoryItem` views, `MemoryError`), who acts on it (`MemoryActor`) and
// what each actor may read and write.
import { createHash } from "node:crypto";
import { z } from "zod";
import { databaseError, type memoryItems } from "@open-bot/db";
import {
  type MemoryItem,
  type MemorySaveOutcome,
  type MemorySource,
  normalizeMemory,
} from "@open-bot/domain";

export class MemoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** `reused-id`: a client id already names a different memory, so this isn't a retry of it. */
    readonly reason?: "reused-id",
  ) {
    super(message);
  }
}
export type MemoryActor =
  | { kind: "user" }
  | {
      kind: "teammate";
      teammateId: string;
      runId: string;
      messageId?: string;
      verified?: boolean;
      allowShared?: boolean;
    };
export type MemorySaveResult = MemoryItem & {
  saveOutcome: MemorySaveOutcome;
};
export type Row = typeof memoryItems.$inferSelect;
export function itemView(row: Row): MemoryItem {
  return {
    id: row.id,
    teammateId: row.teammateId,
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
export function sourceOf(actor: MemoryActor): MemorySource {
  return actor.kind === "teammate"
    ? {
        type: "teammate",
        runId: actor.runId,
        ...(actor.messageId ? { messageId: actor.messageId } : {}),
      }
    : { type: "user" };
}
export function canRead(actor: MemoryActor, teammateId: string | null): boolean {
  return actor.kind !== "teammate" || teammateId === null || teammateId === actor.teammateId;
}
export function canWrite(actor: MemoryActor, teammateId: string | null): boolean {
  return (
    actor.kind !== "teammate" ||
    teammateId === actor.teammateId ||
    (teammateId === null && (actor.verified === true || actor.allowShared === true))
  );
}
export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new MemoryError(400, result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

/**
 * Runs `work`, failing with the database's own error (without values) rather than Drizzle's
 * wrapper, whose message is the failed SQL. Callers show these messages.
 */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw databaseError(error);
  }
}
