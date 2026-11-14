import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * What you'd typed in each chat but not sent, so leaving a chat (for an approval, the screen, or
 * another app) doesn't lose it. Kept on the phone; sending a message clears its draft.
 */
const KEY = "openbot:drafts";
/** The most drafts kept, newest first, so the store can't grow without end. */
const MAX = 50;

export interface Draft {
  text: string;
  /**
   * Teammates it's addressed to, by id, as `chats.send` takes mentions, besides any `@Name` typed
   * in the text: a reply kept from a notification is for the teammate who wrote. Never written
   * into the text, so a name that's ambiguous or has changed can't change who gets it.
   */
  mentions: string[];
}

export const EMPTY_DRAFT: Draft = { text: "", mentions: [] };

/** Stored as the text alone (all older builds wrote), or with whom it's for. */
type Stored = string | Draft;

function toDraft(stored: unknown): Draft {
  if (typeof stored === "string") return { text: stored, mentions: [] };
  if (stored && typeof stored === "object" && typeof (stored as Draft).text === "string") {
    const { text, mentions } = stored as Draft;
    return {
      text,
      mentions: Array.isArray(mentions)
        ? mentions.filter((id): id is string => typeof id === "string" && id !== "")
        : [],
    };
  }
  return EMPTY_DRAFT;
}

let drafts: Record<string, Stored> = {};
const loaded = AsyncStorage.getItem(KEY)
  .then((saved) => {
    if (saved) drafts = { ...(JSON.parse(saved) as Record<string, Stored>), ...drafts };
  })
  .catch(() => {});

let timer: ReturnType<typeof setTimeout> | null = null;
/** Whether the drafts reached the phone's storage. */
function persist(): Promise<boolean> {
  return AsyncStorage.setItem(KEY, JSON.stringify(drafts)).then(
    () => true,
    () => false,
  );
}
function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void persist();
  }, 400);
}

function put(chatId: string, draft: Draft) {
  const { [chatId]: _previous, ...rest } = drafts;
  const stored: Stored = draft.mentions.length ? draft : draft.text;
  drafts = draft.text.trim()
    ? Object.fromEntries([[chatId, stored], ...Object.entries(rest)].slice(0, MAX))
    : rest;
}

/** The chat's draft, once the saved drafts have been read. */
export async function readDraft(chatId: string): Promise<Draft> {
  await loaded;
  return toDraft(drafts[chatId]);
}

export function writeDraft(chatId: string, draft: Draft) {
  put(chatId, draft);
  save();
}

/** A reply that couldn't be sent, added after what the draft already has, for whom it was. */
export function appendKept(draft: Draft, text: string, teammateId: string | null): Draft {
  const before = draft.text.trimEnd();
  return {
    text: before ? `${before}\n\n${text}` : text,
    mentions:
      teammateId && !draft.mentions.includes(teammateId)
        ? [...draft.mentions, teammateId]
        : draft.mentions,
  };
}

/** A reply a notification couldn't send, kept for the teammate it was to (when known). */
export interface Kept {
  text: string;
  teammateId: string | null;
}

/**
 * What's left once a send went through: the replies kept while it was on its way, each for its
 * teammate, and nothing of what it sent. Built from those replies, not by comparing text, so
 * whitespace or a repeated phrase can't make the sent text stay.
 */
export function afterSend(keptSince: readonly Kept[]): Draft {
  return keptSince.reduce(
    (draft, kept) => appendKept(draft, kept.text, kept.teammateId),
    EMPTY_DRAFT,
  );
}

/** What a reply kept from a notification added, and the chat's draft with it. */
export type KeptListener = (kept: Kept, after: Draft) => void;
const listeners = new Map<string, Set<KeptListener>>();

/** Hears about replies kept for the chat from elsewhere: a notification's Reply. */
export function onKeptReply(chatId: string, listener: KeptListener): () => void {
  const set = listeners.get(chatId) ?? new Set();
  set.add(listener);
  listeners.set(chatId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(chatId);
  };
}

/**
 * Keeps a reply you couldn't send as the chat's draft, after anything already there, addressed to
 * the teammate it was for when that's known, and stores it at once: a notification's Reply runs in
 * a background task that can stop right after. A composer showing the chat hears about it first.
 * Says whether it reached the phone's storage.
 */
export async function keepReply(
  chatId: string,
  text: string,
  teammateId: string | null,
): Promise<boolean> {
  await loaded;
  const after = appendKept(toDraft(drafts[chatId]), text, teammateId);
  put(chatId, after);
  for (const listener of listeners.get(chatId) ?? []) listener({ text, teammateId }, after);
  if (timer) clearTimeout(timer);
  timer = null;
  return persist();
}
