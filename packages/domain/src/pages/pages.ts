/**
 * Pages: self-contained HTML a teammate builds for you (an explainer, a comparison, a dashboard),
 * published as versions you open in the apps. Nothing here needs Node, so the phone can use it.
 */

/** The largest page a teammate can publish. Images go inside the file, as data URLs or SVG. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PAGE_LABEL = "5 MB";

/** How much of a page's text is kept for search and for teammates to read back. */
export const MAX_PAGE_TEXT_CHARS = 200_000;

export const MAX_PAGE_TITLE = 120;
export const MAX_PAGE_SUMMARY = 400;

/** Where the libraries, the page kit and the runtime are served, on the page's own origin. */
export const PAGE_LIB_PATH = "/lib/";
/** The script every served page gets, ahead of its own: links, theme and "Ask about this". */
export const PAGE_RUNTIME_PATH = "/lib/runtime.js";

/** The width a phone shows a page at, and the width of a laptop window. */
export const PAGE_CHECK_WIDTHS = { phone: 390, desktop: 1280 } as const;

/**
 * What a page may do. It runs in a sandbox with an origin of its own (never the app's), can't
 * make network requests, and loads code only from itself and the shared libraries. Links still
 * open, in a new tab.
 *
 * `origin` is where the page is served (the pages service, or the computer's preview server),
 * and `frameAncestors` the app origins allowed to show it in a frame.
 */
export function pageContentSecurityPolicy(origin: string, frameAncestors: string[]): string {
  const lib = `${origin.replace(/\/+$/, "")}${PAGE_LIB_PATH}`;
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${lib}`,
    `style-src 'unsafe-inline' ${lib}`,
    `font-src data: ${lib}`,
    `img-src data: blob: ${lib}`,
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
  ].join("; ");
}

/** Headers every page response carries, besides its CSP. */
export const PAGE_RESPONSE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  // A link from a page never tells the site it leads to where you were (the URL has a key in it).
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=()",
} as const;

/**
 * The page with the runtime script added at the very start of its head, so it runs before the
 * page's own scripts. Stored versions never contain it: it's added each time a page is served.
 */
export function injectPageRuntime(html: string, runtimeUrl: string): string {
  const tag = `<script src="${runtimeUrl}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length);
  return tag + html;
}

/** How the app tells a page to look, and whether to offer "Ask about this". */
export interface PageViewOptions {
  theme?: "light" | "dark";
  ask?: boolean;
}

/** View options as the query a page's URL carries. */
export function pageViewQuery(options: PageViewOptions): string {
  const params = new URLSearchParams();
  if (options.theme) params.set("theme", options.theme);
  if (options.ask) params.set("ask", "1");
  return params.toString();
}

/** A passage you picked in a page to ask its teammate about, as the runtime sends it to the app. */
export interface PageAskMessage {
  source: "openbot-page";
  type: "ask";
  /** The text you selected. */
  quote: string;
  /** The heading above it, if any. */
  section: string | null;
}

export const MAX_PAGE_QUOTE = 1000;

/** A message from a page, if it's an "Ask about this". Pages are untrusted, so this checks everything. */
export function parsePageAskMessage(data: unknown): PageAskMessage | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.source !== "openbot-page" || message.type !== "ask") return null;
  if (typeof message.quote !== "string") return null;
  const quote = message.quote.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_QUOTE);
  if (!quote) return null;
  const section =
    typeof message.section === "string" && message.section.trim()
      ? message.section.replace(/\s+/g, " ").trim().slice(0, 200)
      : null;
  return { source: "openbot-page", type: "ask", quote, section };
}

/** What the teammate gets when you ask about a page: which page and version, what you picked, and your words. */
export function pageQuestionText(input: {
  pageId: string;
  title: string;
  version: number;
  quote?: string | null;
  section?: string | null;
  text: string;
}): string {
  const lines = [
    `About your page “${input.title}” (page_id ${input.pageId}, version ${input.version}):`,
  ];
  if (input.section) lines.push(`Section: ${input.section}`);
  if (input.quote) lines.push(...input.quote.split("\n").map((line) => `> ${line}`));
  lines.push("", input.text.trim());
  return lines.join("\n");
}

/** A finding from checking a page: errors stop it from being published; warnings don't. */
export interface PageIssue {
  level: "error" | "warning";
  message: string;
}

/** A page that was checked on the computer, as the worker gets it back. */
export interface PageCheckResult {
  ok: true;
  /** The exact file that was checked, so the version stored is the one you saw. */
  htmlBase64: string;
  size: number;
  sha256: string;
  /** The page's <title>, if it has one. */
  title: string;
  /** The text you'd read, for search and for teammates to read back later. */
  text: string;
  issues: PageIssue[];
  /** JPEG screenshots of the top of the page, at each width. */
  screenshots: { phone: string; desktop: string };
  /** Small JPEGs of the top of the page at laptop width, for cards: light, and dark. */
  thumbnail: string;
  thumbnailDark: string;
}

export interface PageCheckError {
  ok: false;
  message: string;
}

/** A page's path on the computer: an HTML file in a workspace or the shared folder. */
export const PAGE_SOURCE_PATH =
  /^\/home\/bot\/(?:bots|shared)\/(?:[^/.][^/]*\/)*[^/.][^/]*\.html?$/;

export function isPageSourcePath(path: string): boolean {
  return PAGE_SOURCE_PATH.test(path) && !path.split("/").includes("..");
}
