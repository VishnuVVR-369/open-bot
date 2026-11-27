import type { MemoryRunRef } from "@open-bot/api";
import {
  MEMORY_KIND_LABELS,
  memoryExpired,
  memorySourceLabel,
  memoryTextProblem,
  type MemoryInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type MemorySaveOutcome,
} from "@open-bot/domain";
import type { Href } from "expo-router";

/** Where memory lives in the app, and the rules its screens follow. */

/** Memory: the shared memories, or one teammate's. */
export const memoryListHref = (teammateId: string | null = null): Href =>
  teammateId ? `/memory?teammateId=${teammateId}` : "/memory";
export const memoryHref = (memoryId: string, outcome?: MemorySaveOutcome): Href =>
  outcome ? `/memory/${memoryId}?saved=${outcome}` : `/memory/${memoryId}`;
export const memoryHistoryHref = (memoryId: string): Href => `/memory/${memoryId}/history`;
export const newMemoryHref = (teammateId: string | null): Href =>
  teammateId ? `/memory/new?teammateId=${teammateId}` : "/memory/new";
export const lessonsHref = (teammateId: string): Href => `/memory/lessons?teammateId=${teammateId}`;

/** The chip for memories every teammate shares, before one chip per teammate. */
export const SHARED_SCOPE = "shared";

/** The scopes to pick between: shared memory, then each teammate's own. */
export function memoryScopes(teammates: readonly { id: string; name: string }[]) {
  return [
    { key: SHARED_SCOPE, label: "Shared" },
    ...teammates.map((teammate) => ({ key: teammate.id, label: teammate.name })),
  ];
}

/** The teammate a scope chip is for, or null for shared memory. */
export const scopeTeammate = (scope: string): string | null =>
  scope === SHARED_SCOPE ? null : scope;

/**
 * Whether a list read under `key` (`queryKeys.memories`) is of the same scope as `teammateId`'s, so
 * its results may stand in while a new search in that scope loads.
 */
export const sameMemoryScope = (key: readonly unknown[], teammateId: string | null) =>
  key[0] === "memory" && key[1] === "list" && key[2] === teammateId;

/** What the memory form edits. The topic key and expiry are kept as they are, or cleared. */
export interface MemoryForm {
  content: string;
  kind: MemoryKind;
  pinned: boolean;
  key: string | null;
  expiresAt: string | null;
}

export const emptyMemoryForm = (): MemoryForm => ({
  content: "",
  kind: "fact",
  pinned: false,
  key: null,
  expiresAt: null,
});

export const memoryForm = (item: MemoryItem): MemoryForm => ({
  content: item.content,
  kind: item.kind,
  pinned: item.pinned,
  key: item.key,
  expiresAt: item.expiresAt,
});

export function memoryFormChanged(a: MemoryForm, b: MemoryForm): boolean {
  return (
    a.content !== b.content ||
    a.kind !== b.kind ||
    a.pinned !== b.pinned ||
    a.key !== b.key ||
    a.expiresAt !== b.expiresAt
  );
}

export const memoryFormProblem = (form: MemoryForm) =>
  memoryTextProblem(form.content, form.key ?? "");

/** What saving the form sends, for one teammate's memory or (null) a shared one. */
export const memoryInput = (form: MemoryForm, teammateId: string | null): MemoryInput => ({
  teammateId,
  content: form.content.trim(),
  kind: form.kind,
  pinned: form.pinned,
  key: form.key,
  expiresAt: form.expiresAt,
});

/**
 * A memory's form: the memory it was opened at (`base`, whose revision a save sends, or null for a
 * new one), what the form started as, and what it says now.
 */
export interface MemoryDraft {
  base: MemoryItem | null;
  start: MemoryForm;
  form: MemoryForm;
}

export const memoryDraft = (item: MemoryItem | null): MemoryDraft => {
  const form = item ? memoryForm(item) : emptyMemoryForm();
  return { base: item, start: form, form };
};

/**
 * A fresher copy of the memory arrived (changed on the web, by a teammate, or restored). An
 * untouched form follows it. One with your changes keeps them, and keeps the revision you
 * started from, so saving them is refused as a conflict instead of overwriting what changed.
 */
export function followMemory(draft: MemoryDraft, fresh: MemoryItem): MemoryDraft {
  if (!draft.base) return draft;
  if (fresh.revision === draft.base.revision && fresh.state === draft.base.state) return draft;
  return memoryFormChanged(draft.start, draft.form) ? draft : memoryDraft(fresh);
}

/** The memory changed since the form started from it, so the form can't be saved over it. */
export const changedSince = (draft: MemoryDraft, latest: MemoryItem | null | undefined) =>
  draft.base !== null && latest != null && latest.revision !== draft.base.revision;

/** What the app says when a save changed something else than adding what you wrote. */
export function saveNote(outcome: string | undefined): string | null {
  if (outcome === "unchanged") return "You'd already saved this, so nothing was added.";
  if (outcome === "confirmed") return "A teammate had suggested this. It's confirmed now.";
  return null;
}

/**
 * A new memory's save: what it sends and the id it's saved under. A save whose answer was lost is
 * sent again exactly, with the same id, so the server answers with the memory the first attempt
 * added (as it is now) and never adds it twice.
 */
export interface MemoryCreate {
  input: MemoryInput;
  id: string;
}

/** The save to send: the lost one again, or the form as it is with a fresh id. */
export const memoryCreate = (
  lost: MemoryCreate | null,
  form: MemoryForm,
  teammateId: string | null,
  newId: () => string,
): MemoryCreate => lost ?? { input: memoryInput(form, teammateId), id: newId() };

/** A fresh read of the memory, for Reload after a conflict: it, or why it couldn't be read. */
export type MemoryReload = { ok: true; item: MemoryItem } | { ok: false; message: string };

/**
 * The form after Reload. Only a fresh read replaces your changes with the saved version; a failed
 * one (offline, the server failing, or the memory gone) keeps them and the conflict, and says why.
 */
export function afterReload(
  draft: MemoryDraft,
  result: MemoryReload,
): { draft: MemoryDraft; refused: boolean; problem: string | null } {
  if (result.ok) return { draft: memoryDraft(result.item), refused: false, problem: null };
  return { draft, refused: true, problem: result.message };
}

/**
 * What leaving asks first, or null to just leave: your changes aren't saved, and once the memory
 * was forgotten they can't be, so it says to copy them first.
 */
export function leaveQuestion(
  changed: boolean,
  leaving: boolean,
  gone: boolean,
): { title: string; body: string } | null {
  if (!changed || leaving) return null;
  return gone
    ? {
        title: "Discard what you wrote?",
        body: "This memory was forgotten, so what you wrote here can't be saved. Copy it first to keep it.",
      }
    : { title: "Discard your changes?", body: "What you changed in this memory isn't saved." };
}

/** What a reply was given, as one line each: the memory then, or why it can't be shown. */
export function runMemoryText(ref: MemoryRunRef): { text: string; faded: boolean } {
  if (ref.forgotten) return { text: "Forgotten memory", faded: true };
  if (ref.changed || ref.content === null)
    return { text: "Memory changed since this reply", faded: true };
  return { text: ref.content, faded: false };
}

/** How many memories a list holds, saying when it's cut at the limit. */
export function memoryCount(count: number, limit: number): string {
  if (count === 0) return "Nothing saved yet";
  if (count >= limit) return `The newest ${limit} memories`;
  return count === 1 ? "1 memory" : `${count} memories`;
}

/** When a memory expires, or did: "Expires 3 Dec", "Expired 3 Dec". */
export function expiryLabel(expiresAt: string, now = new Date()): string {
  const day = new Date(expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${memoryExpired({ expiresAt }, now) ? "Expired" : "Expires"} ${day}`;
}

/** What a memory's row says above its text: its type, who saved it, and how it stands. */
export function memoryMeta(item: MemoryItem, savedBy: string | null, now = new Date()): string[] {
  return [
    MEMORY_KIND_LABELS[item.kind],
    memorySourceLabel(item, savedBy),
    ...(item.pinned ? ["Pinned"] : []),
    ...(item.expiresAt ? [expiryLabel(item.expiresAt, now)] : []),
    ...(item.revision > 1 ? [`Revision ${item.revision}`] : []),
  ];
}

/** A read as the history screen sees it. */
interface Read<T> {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
}

/**
 * What a memory's history screen shows, from its two reads. The server saying either is gone (the
 * memory was forgotten, which removes its history too) hides what was cached, so nothing offers to
 * restore a memory that's gone. A failure that may pass keeps what was read before on screen.
 */
export function historyScreenState<M, R>(
  memory: Read<M>,
  history: Read<R[]>,
  isGone: (error: unknown) => boolean,
):
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; current: M; revisions: R[] } {
  const failed = [memory.error, history.error].filter((error) => error != null);
  if (failed.some(isGone)) return { kind: "gone" };
  if (memory.data !== undefined && history.data !== undefined)
    return { kind: "ready", current: memory.data, revisions: history.data };
  if (failed.length) return { kind: "error", error: failed[0] };
  return { kind: "loading" };
}

/** Who made a revision, in a few words. */
export function revisionSource(revision: Pick<MemoryRevision, "source">): string {
  switch (revision.source.type) {
    case "user":
      return "By you";
    case "feedback":
      return "From your feedback";
    case "import":
      return "Imported";
    case "teammate":
      return "By a teammate";
    case "extraction":
      return "From a conversation";
  }
}
