import {
  MEMORY_CONTENT_MAX,
  MEMORY_CONTENT_MIN,
  MEMORY_KEY_MAX,
  type MemoryItem,
  type MemoryKind,
} from "./memory";

/** How memory is shown to the owner, the same on the web and the phone. */

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  lesson: "Lesson",
  note: "Note",
};

/** The most memories one list shows; a search finds older ones. */
export const MEMORY_LIST_LIMIT = 200;

/** A memory a teammate suggested, which only counts once you confirm it. */
export const isSuggestion = (item: Pick<MemoryItem, "state">) => item.state === "candidate";

/** Whether a memory's expiry has passed: it stays listed, but teammates no longer get it. */
export function memoryExpired(item: Pick<MemoryItem, "expiresAt">, now = new Date()): boolean {
  return item.expiresAt !== null && new Date(item.expiresAt) <= now;
}

/** Who saved a memory, by name when a teammate did (`teammate` is that teammate's name). */
export function memorySourceLabel(
  item: Pick<MemoryItem, "state" | "source">,
  teammate: string | null,
): string {
  if (item.source.type === "feedback") return "From your feedback";
  if (item.source.type === "import") return "Imported";
  if (item.source.type === "user") return "Saved by you";
  const verb = isSuggestion(item) || item.source.type === "extraction" ? "Suggested" : "Saved";
  if (teammate) return `${verb} by ${teammate}`;
  return item.source.type === "extraction"
    ? `${verb} from a conversation`
    : `${verb} by a teammate`;
}

/** What to ask before forgetting a memory, or dismissing a suggestion. */
export function forgetMemoryQuestion(item: Pick<MemoryItem, "state">): {
  title: string;
  body: string;
  action: string;
} {
  const suggestion = isSuggestion(item);
  return {
    title: suggestion ? "Dismiss this suggestion?" : "Forget this memory?",
    body: "Saved versions and search results will be removed. Original conversations remain. Running tasks will stop so they can restart with current facts.",
    action: suggestion ? "Dismiss suggestion" : "Forget memory",
  };
}

/** The first thing wrong with a memory as written, or null when it can be saved. */
export function memoryTextProblem(content: string, key = ""): string | null {
  const text = content.trim();
  if (text.length < MEMORY_CONTENT_MIN) return "Write at least a few characters.";
  if (text.length > MEMORY_CONTENT_MAX) return "Keep it under 8,000 characters.";
  if (key.trim().length > MEMORY_KEY_MAX) return "Keep the topic key under 120 characters.";
  return null;
}
