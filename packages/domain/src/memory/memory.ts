import { z } from "zod";

export const MEMORY_KINDS = ["fact", "preference", "lesson", "note"] as const;
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATES = ["active", "candidate", "deleted"] as const;
export const memoryStateSchema = z.enum(MEMORY_STATES);
export type MemoryState = (typeof MEMORY_STATES)[number];

/** What saving a memory did: added it, confirmed one that said the same, or found it unchanged. */
export const memorySaveOutcomeSchema = z.enum(["created", "confirmed", "unchanged"]);
export type MemorySaveOutcome = z.infer<typeof memorySaveOutcomeSchema>;

export const memorySourceSchema = z.object({
  type: z.enum(["user", "feedback", "bot", "import", "extraction"]),
  messageId: z.string().optional(),
  runId: z.string().optional(),
  chatId: z.string().optional(),
  /** The teammate whose run saved it, filled in when memory is listed for display. */
  botId: z.string().optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryItemSchema = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  kind: memoryKindSchema,
  content: z.string(),
  key: z.string().nullable(),
  revision: z.number(),
  state: memoryStateSchema,
  pinned: z.boolean(),
  expiresAt: z.string().nullable(),
  source: memorySourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryRevisionSchema = z.object({
  revision: z.number(),
  content: z.string(),
  state: memoryStateSchema,
  source: memorySourceSchema,
  createdAt: z.string(),
});
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;

/** What a revision keeps besides its content: the memory's settings when it was saved. */
export interface MemorySnapshot {
  kind: MemoryKind;
  key: string | null;
  pinned: boolean;
  /** ISO time, as JSON keeps it. */
  expiresAt: string | null;
  state: MemoryState;
}

export const MEMORY_JOB_KINDS = ["embed", "extract"] as const;
export type MemoryJobKind = (typeof MEMORY_JOB_KINDS)[number];

/** One memory a run was given, at the revision it saw. */
export interface MemoryRef {
  id: string;
  revision: number;
}

export const memoryInputSchema = z.object({
  botId: z.string().uuid().nullable().default(null),
  kind: memoryKindSchema.default("fact"),
  content: z.string().trim().min(3).max(8000),
  key: z.string().trim().min(1).max(120).nullable().default(null),
  pinned: z.boolean().default(false),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export const memoryEditSchema = memoryInputSchema.extend({
  id: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
export const memoryReferenceSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});

/** Normalize only formatting, never infer that two different facts mean the same thing. */
export function normalizeMemory(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function memoryMarkdown(
  items: Pick<MemoryItem, "id" | "content" | "revision" | "kind">[],
): string {
  return (
    "# Memory\n\nGenerated from saved memory. Use memory tools to change it; file edits are not imported.\n\n" +
    items
      .map((item) => `## ${item.kind} [${item.id}@${item.revision}]\n\n${item.content}`)
      .join("\n\n") +
    "\n"
  );
}

/** Bounded context, with no assumption that a token always has four characters. */
export function memoryContext(
  items: MemoryItem[],
  maxChars = 6000,
): { text: string; refs: MemoryRef[] } {
  let text = "";
  const refs: MemoryRef[] = [];
  for (const item of items) {
    const heading = `[memory:${item.id}@${item.revision}; ${item.botId ? "this bot" : "shared"}; ${item.kind}]\n`;
    const available = maxChars - text.length - heading.length - 2;
    if (available < 80) break;
    const content =
      item.content.length > available ? item.content.slice(0, available - 1) + "…" : item.content;
    text += heading + content + "\n\n";
    refs.push({ id: item.id, revision: item.revision });
  }
  return { text, refs };
}

/** Conservative intent checks; ambiguous requests stay suggestions rather than confirmed facts. */
export function hasMemorySaveIntent(text: string): boolean {
  if (
    /\b(?:do not|don't|never|avoid|stop)\s+(?:\w+\s+){0,2}(?:remember|save|keep|memorize)\b/i.test(
      text,
    )
  )
    return false;
  return /\b(remember|save|keep|memorize|update|correct)\b/i.test(text);
}
export function hasMemoryForgetIntent(text: string): boolean {
  if (/\b(?:do not|don't|never|avoid|stop)\s+(?:\w+\s+){0,2}(?:forget|remove|delete)\b/i.test(text))
    return false;
  return (
    /\bforget\b/i.test(text) ||
    /\b(?:remove|delete)\b[\s\S]{0,60}\b(?:memor(?:y|ies)|saved fact|preference|lesson)\b/i.test(
      text,
    )
  );
}
