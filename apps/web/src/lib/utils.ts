import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Markdown reduced to plain text, for one-line previews. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:>|[-*+]\s|\d+\.\s)\s*/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?!\s)([^*_\n]+?)(?<!\s)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A chat's address, scrolled to one run when it's given. */
export function chatHref(chatId: string, runId?: string | null): string {
  return runId ? `/chats/${chatId}#run-${runId}` : `/chats/${chatId}`;
}

/**
 * For a reply's header controls: shown when you hover or focus the reply, and taking no room
 * otherwise, so what's always shown (like your rating) sits next to the name. Still reachable with
 * the keyboard, since focusing one reveals them all. Anything marked `data-pinned` in the reply,
 * like an open menu, keeps them shown so they don't shift under it.
 */
export const REVEAL_ON_RUN_HOVER =
  "max-w-0 overflow-hidden opacity-0 transition-opacity group-hover/run:max-w-none group-hover/run:opacity-100 group-focus-within/run:max-w-none group-focus-within/run:opacity-100 group-has-[[data-pinned]]/run:max-w-none group-has-[[data-pinned]]/run:opacity-100 pointer-coarse:max-w-none pointer-coarse:opacity-100";

/** 18200 as "18.2K". */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** How long something took, like "42s", "3m 5s" or "1h 2m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
