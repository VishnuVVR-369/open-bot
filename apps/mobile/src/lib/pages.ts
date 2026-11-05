import type { BotSummary, ChatSummary, PageLink, PageSummary } from "@open-bot/api";
import { parsePageAskMessage, type PageAskMessage } from "@open-bot/shared";
import type { Href } from "expo-router";
import { APP_URL } from "./config";

/** A page in the app, opened at one version when it's given. */
export const pageHref = (pageId: string, versionId?: string | null): Href =>
  versionId ? `/pages/${pageId}?v=${versionId}` : `/pages/${pageId}`;

/** A version's picture for cards, in the light or dark theme; it needs your session, like files do. */
export const pageThumbnailUrl = (versionId: string, theme: "light" | "dark" = "light") =>
  `${APP_URL}/api/pages/versions/${encodeURIComponent(versionId)}/thumbnail${theme === "dark" ? "?theme=dark" : ""}`;

/**
 * Whether a page link still works long enough to load the page. Links last a few minutes; one
 * that's nearly out is replaced before it's used.
 */
export function isLinkFresh(
  link: Pick<PageLink, "expiresAt">,
  now = Date.now(),
  marginMs = 30_000,
) {
  const expires = Date.parse(link.expiresAt);
  return Number.isFinite(expires) && expires - now > marginMs;
}

/** What a page in the viewer asks the app for, through the WebView's message channel. */
export type PageMessage = PageAskMessage | { source: "openbot-page"; type: "open"; url: string };

/**
 * A message from a page, if it's one the app acts on. Pages are untrusted: "open" only ever
 * opens a web or mail link outside the app, and "ask" only prefills a question you send yourself.
 */
export function parsePageMessage(data: string): PageMessage | null {
  const ask = parsePageAskMessage(data);
  if (ask) return ask;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.source !== "openbot-page" || message.type !== "open") return null;
  if (typeof message.url !== "string" || message.url.length > 4000) return null;
  let url: URL;
  try {
    url = new URL(message.url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
  return { source: "openbot-page", type: "open", url: url.href };
}

/**
 * Where a question about a page goes: the chat it was made in (a direct or group chat you can
 * still see), else its teammate's own chat. Null when its teammate is gone.
 */
export function questionTarget(
  page: Pick<PageSummary, "botId" | "chatId">,
  bots: BotSummary[],
  chats: ChatSummary[],
): { bot: BotSummary; chat: ChatSummary } | null {
  const bot = bots.find((candidate) => candidate.id === page.botId);
  if (!bot) return null;
  const origin = chats.find((chat) => chat.id === page.chatId);
  if (origin && (origin.kind === "direct" || origin.kind === "group")) return { bot, chat: origin };
  const direct = chats.find((chat) => chat.id === bot.directChatId);
  return direct ? { bot, chat: direct } : null;
}

/** Pages pinned first, then the most recently changed; the order the server sends, kept here too. */
export function sortPages(pages: PageSummary[]): PageSummary[] {
  return [...pages].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** "2.1 MB", for a version's size. */
export function pageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
