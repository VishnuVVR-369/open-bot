import { mentionedIds } from "@open-bot/chat-core";
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
   * Teammates the text is for that it doesn't name yet: a reply kept from a notification knows
   * its teammate's id but not their name. The composer writes them in as `@Name`.
   */
  mentions: string[];
}

/** Stored as the text alone, or with the teammates it's for. */
type Stored = string | { text: string; mentions: string[] };

const EMPTY: Draft = { text: "", mentions: [] };
const toDraft = (stored: Stored | undefined): Draft =>
  stored === undefined
    ? EMPTY
    : typeof stored === "string"
      ? { text: stored, mentions: [] }
      : { text: stored.text, mentions: stored.mentions };
const toStored = (draft: Draft): Stored =>
  draft.mentions.length ? { text: draft.text, mentions: draft.mentions } : draft.text;

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
  drafts = draft.text.trim()
    ? Object.fromEntries([[chatId, toStored(draft)], ...Object.entries(rest)].slice(0, MAX))
    : rest;
}

/** The chat's draft, once the saved drafts have been read. */
export async function readDraft(chatId: string): Promise<Draft> {
  await loaded;
  return toDraft(drafts[chatId]);
}

/**
 * What you typed. Teammates it's for that it doesn't name yet stay with it (`mentions`), until
 * the composer can write their names in.
 */
export function writeDraft(chatId: string, text: string, mentions: string[] = []) {
  put(chatId, { text, mentions });
  save();
}

/**
 * Writes the teammates a draft is for into its text as `@Name`, so sending it mentions them. Only
 * a group chat needs that. A teammate the chat doesn't have is dropped, unless its members aren't
 * known yet: then they stay `pending`.
 */
export function nameMentions(
  draft: Draft,
  chat: { isGroup: boolean; members: readonly { id: string; name: string }[] },
): { text: string; pending: string[] } {
  if (!chat.isGroup || draft.mentions.length === 0) return { text: draft.text, pending: [] };
  if (chat.members.length === 0) return { text: draft.text, pending: draft.mentions };
  const names = draft.mentions
    .map((id) => chat.members.find((member) => member.id === id))
    .filter((member) => member && mentionedIds(draft.text, [member]).length === 0)
    .map((member) => `@${member!.name} `);
  return { text: names.join("") + draft.text, pending: [] };
}

/** The new draft, and the text just added to it. */
type Listener = (draft: Draft, added: string) => void;
const listeners = new Map<string, Set<Listener>>();

/** Hears about drafts kept for the chat from elsewhere, like a notification's Reply. */
export function onKeptDraft(chatId: string, listener: Listener): () => void {
  const set = listeners.get(chatId) ?? new Set();
  set.add(listener);
  listeners.set(chatId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(chatId);
  };
}

/**
 * Keeps text you couldn't send as the chat's draft, after anything already there, for the
 * teammate it was for (if known), and stores it at once: a notification's Reply runs in a
 * background task that can stop right after. Says whether it reached storage. A composer showing
 * the chat hears about it.
 */
export async function keepDraft(
  chatId: string,
  text: string,
  teammateId: string | null,
): Promise<boolean> {
  await loaded;
  const previous = toDraft(drafts[chatId]);
  const before = previous.text.trimEnd();
  const draft: Draft = {
    text: before ? `${before}\n\n${text}` : text,
    mentions:
      teammateId && !previous.mentions.includes(teammateId)
        ? [...previous.mentions, teammateId]
        : previous.mentions,
  };
  put(chatId, draft);
  // Before waiting on storage, so nothing typed in between can write over it.
  for (const listener of listeners.get(chatId) ?? []) listener(draft, text);
  if (timer) clearTimeout(timer);
  timer = null;
  return persist();
}
