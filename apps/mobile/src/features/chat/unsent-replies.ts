import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { useSyncExternalStore } from "react";

/**
 * Replies typed into a notification that couldn't be sent, each kept on its own until you send or
 * discard it from its chat. They're never merged into the composer's text, so nothing the composer
 * does (a send, dictation, a draft loading) can bring one back, change it, or lose it.
 *
 * This store is the only copy. It reads the phone's storage once; every change waits for that read
 * and is then applied here at once, so a read can never overwrite a newer change. Components
 * subscribe to it (`useUnsentReplies()`) instead of keeping copies.
 */
const KEY = "openbot:unsent-replies";
/** The most kept, newest last, so the store can't grow without end. */
const MAX = 50;

export interface UnsentReply {
  /** Stable: the id of the notification saying it wasn't sent (`unsentReplyId()`). */
  id: string;
  chatId: string;
  text: string;
  /** Whom it's for, by id, as `chats.send` takes mentions; null when the notification didn't say. */
  teammateId: string | null;
  /** The notification it was typed into. */
  notificationId: string;
  /**
   * The message id it's sent with. Sending it again (after a failure, or after the app was closed
   * mid-send) reuses it, so it's delivered once; an edit gets a new one.
   */
  clientId: string;
}

/** An unsent reply as a chat shows it: whether it's being sent, and why the last try failed. */
export interface UnsentReplyView extends UnsentReply {
  sending: boolean;
  error: string | null;
}

let replies: UnsentReply[] = [];
/** Replies being sent now, by id: in memory, so a second composer can't send one twice. */
const sending = new Set<string>();
const errors = new Map<string, string>();

function isReply(value: unknown): value is UnsentReply {
  const reply = value as UnsentReply | null;
  return (
    typeof reply === "object" &&
    reply !== null &&
    typeof reply.id === "string" &&
    typeof reply.chatId === "string" &&
    typeof reply.text === "string" &&
    (reply.teammateId === null || typeof reply.teammateId === "string") &&
    typeof reply.notificationId === "string" &&
    typeof reply.clientId === "string"
  );
}

const loaded: Promise<void> = AsyncStorage.getItem(KEY)
  .then((saved) => {
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    // Nothing can have changed yet: every change waits for this.
    replies = Array.isArray(parsed) ? parsed.filter(isReply) : [];
  })
  .catch(() => {})
  .then(() => changed());

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

// Writes go one after another, each with all replies as they are when it runs, so the last one
// to land is always the newest.
let writing: Promise<boolean> = Promise.resolve(true);
function persist(): Promise<boolean> {
  writing = writing.then(() =>
    AsyncStorage.setItem(KEY, JSON.stringify(replies)).then(
      () => true,
      () => false,
    ),
  );
  return writing;
}

/**
 * Keeps a reply a notification couldn't send, for its chat, and stores it at once: a
 * notification's Reply runs in a background task that can stop right after. The same reply kept
 * again (the same id) stays as it is, with any edit you made. Says whether it's stored.
 */
export async function keepUnsentReply(reply: Omit<UnsentReply, "clientId">): Promise<boolean> {
  await loaded;
  if (!replies.some((kept) => kept.id === reply.id)) {
    replies = [...replies, { ...reply, clientId: Crypto.randomUUID() }].slice(-MAX);
    changed();
  }
  const stored = await persist();
  return stored && replies.some((kept) => kept.id === reply.id);
}

/**
 * Changes a reply's text or whom it's for. Not while it's being sent: what's sent is what's
 * removed once it arrives. Says whether it changed.
 */
export async function editUnsentReply(
  id: string,
  change: { text?: string; teammateId?: string | null },
): Promise<boolean> {
  await loaded;
  const reply = replies.find((kept) => kept.id === id);
  if (!reply || sending.has(id)) return false;
  const text = change.text ?? reply.text;
  if (!text.trim()) return false;
  const teammateId = change.teammateId === undefined ? reply.teammateId : change.teammateId;
  if (text === reply.text && teammateId === reply.teammateId) return true;
  replies = replies.map((kept) =>
    kept.id === id ? { ...kept, text, teammateId, clientId: Crypto.randomUUID() } : kept,
  );
  errors.delete(id);
  changed();
  void persist();
  return true;
}

/** Forgets a reply you don't want to send. Not while it's being sent. Says whether it's gone. */
export async function discardUnsentReply(id: string): Promise<boolean> {
  await loaded;
  if (sending.has(id) || !replies.some((kept) => kept.id === id)) return false;
  remove(id);
  return true;
}

function remove(id: string) {
  replies = replies.filter((kept) => kept.id !== id);
  errors.delete(id);
  changed();
  void persist();
}

/**
 * Sends a reply by id with `deliver`, once: while it's on its way, another send of it does
 * nothing and it can't be edited or discarded. Once it arrives it's removed, by id; when it
 * fails it stays, with the error. Says whether it was sent.
 */
export async function sendUnsentReply(
  id: string,
  deliver: (reply: UnsentReply) => Promise<{ error: string } | null>,
): Promise<boolean> {
  await loaded;
  const reply = replies.find((kept) => kept.id === id);
  if (!reply || sending.has(id)) return false;
  sending.add(id);
  errors.delete(id);
  changed();
  const failure = await deliver(reply).catch(() => ({ error: "Couldn't send. Try again." }));
  sending.delete(id);
  if (failure) {
    errors.set(id, failure.error);
    changed();
    return false;
  }
  remove(id);
  return true;
}

/** On sign-out: what you typed for this account stays with it. */
export async function clearUnsentReplies(): Promise<void> {
  await loaded;
  replies = [];
  errors.clear();
  changed();
  await persist();
}

const views = new Map<string, { version: number; value: readonly UnsentReplyView[] }>();
const NONE: readonly UnsentReplyView[] = [];
/** A chat's unsent replies, oldest first; the same array until something changes. */
export function unsentReplies(chatId: string): readonly UnsentReplyView[] {
  const cached = views.get(chatId);
  if (cached?.version === version) return cached.value;
  const value = replies
    .filter((reply) => reply.chatId === chatId)
    .map((reply) => ({
      ...reply,
      sending: sending.has(reply.id),
      error: errors.get(reply.id) ?? null,
    }));
  const stable = value.length === 0 ? NONE : value;
  views.set(chatId, { version, value: stable });
  return stable;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** A chat's unsent replies, kept up to date. */
export function useUnsentReplies(chatId: string): readonly UnsentReplyView[] {
  return useSyncExternalStore(
    subscribe,
    () => unsentReplies(chatId),
    () => NONE,
  );
}
