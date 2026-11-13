import type { BotSummary, ChatSummary, PageDetail, PageLink, PageSummary } from "@open-bot/api";
import { parsePageAskMessage, type PageAskMessage } from "@open-bot/domain";
import type { Href } from "expo-router";
import { APP_URL } from "./config";
import { ago } from "./time";

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

type Versions = Pick<PageDetail, "versionId" | "versions">;

/** The version a page opens at: the one a link names, if the page has it, else the latest. */
export function openingVersion(page: Versions, asked: string | undefined): string {
  return asked && page.versions.some((version) => version.id === asked) ? asked : page.versionId;
}

/**
 * A newer version to offer while you read an older one: the newest, unless you're on it or
 * already saw it offered (`knownLatest`).
 */
export function newerVersion(
  page: Versions,
  shownId: string | null,
  knownLatest: string | null,
): PageDetail["versions"][number] | null {
  if (!shownId || page.versionId === shownId || page.versionId === knownLatest) return null;
  return page.versions[0] ?? null;
}

/** The line under a page's title: its teammate, then its version, or its age when it has one. */
export function pageSubtitle(
  page: Versions,
  shown: PageDetail["versions"][number] | null,
  teammateName: string | undefined,
): string {
  const version = shown
    ? page.versions.length > 1
      ? `Version ${shown.number}${shown.id !== page.versionId ? " (older)" : ""}`
      : ago(shown.createdAt)
    : null;
  return [teammateName ?? "Former teammate", version].filter(Boolean).join(" · ");
}

/** Whether the viewer may load an address itself: the page, a place in it, or a blank frame. */
export const isPageAddress = (address: string, pageUrl: string) =>
  address.split("#")[0] === pageUrl || address === "about:blank";

/**
 * What to do when the pages service answers a page with an error: a turned-down link gets one new
 * link by itself (`renew`), a missing page means it may be gone (`recheck`), and anything else is
 * shown with a way to try again.
 */
export function pageLoadFailure(
  status: number,
  renewed: boolean,
): { kind: "renew" } | { kind: "recheck" } | { kind: "show"; message: string } {
  if (status === 403 && !renewed) return { kind: "renew" };
  if (status === 404) return { kind: "recheck" };
  return {
    kind: "show",
    message:
      status === 403
        ? "The link to this page expired. Try again for a new one."
        : "open-bot's pages service didn't answer. Try again in a moment.",
  };
}
