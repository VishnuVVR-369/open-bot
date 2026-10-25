import { z } from "zod";

export const memoryKindSchema = z.enum(["fact", "preference", "lesson", "note"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryState = "active" | "candidate" | "deleted";
export interface MemorySource {
  type: "user" | "feedback" | "bot" | "import" | "extraction";
  messageId?: string;
  runId?: string;
  chatId?: string;
}
export interface MemoryItem {
  id: string;
  botId: string | null;
  kind: MemoryKind;
  content: string;
  key: string | null;
  revision: number;
  state: MemoryState;
  pinned: boolean;
  expiresAt: string | null;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryRevision {
  revision: number;
  content: string;
  state: MemoryState;
  source: MemorySource;
  createdAt: string;
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
): { text: string; refs: { id: string; revision: number }[] } {
  let text = "";
  const refs: { id: string; revision: number }[] = [];
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
