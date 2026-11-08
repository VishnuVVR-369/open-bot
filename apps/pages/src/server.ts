import type { IncomingMessage, ServerResponse } from "node:http";
import { readLibFile } from "@open-bot/page-kit/serve";
import { verifyPageVersion } from "@open-bot/domain/server";
import {
  injectPageRuntime,
  PAGE_RESPONSE_HEADERS,
  PAGE_RUNTIME_PATH,
  pageContentSecurityPolicy,
} from "@open-bot/domain";

export interface PagesConfig {
  /** Where this service is reached, like https://openbot-pages.up.railway.app. */
  origin: string;
  /** The app origins that may show pages in a frame. */
  appOrigins: string[];
  /** Shared with the web app, which signs the links. */
  secret: string;
  libDir: string;
  /** A version's HTML and fingerprint, or null when there's no such version. */
  loadVersion(versionId: string): Promise<{ html: string; sha256: string } | null>;
  log: (message: string) => void;
}

const VERSION_PATH = /^\/v\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A short message for someone who opened a link that doesn't work, in plain HTML with no scripts. */
function notice(response: ServerResponse, status: number, title: string, text: string) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#14161b}
@media (prefers-color-scheme:dark){body{background:#0e0f12;color:#eceef1}p{color:#a0a6b0}}
main{max-width:340px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#5f6571}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`);
}

/** Answers requests for pages and their libraries. Everything else is a 404. */
export function createPagesHandler(config: PagesConfig) {
  const csp = pageContentSecurityPolicy(config.origin, config.appOrigins);
  const runtimeUrl = `${config.origin.replace(/\/+$/, "")}${PAGE_RUNTIME_PATH}`;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://pages");
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname.startsWith("/lib/")) {
      const file = await readLibFile(config.libDir, url.pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      response.writeHead(200, file.headers).end(head ? undefined : file.data);
      return;
    }
    const match = VERSION_PATH.exec(url.pathname);
    if (!match) {
      notice(response, 404, "Nothing here", "Pages open from the open-bot app.");
      return;
    }
    const versionId = match[1]!.toLowerCase();
    if (!verifyPageVersion(versionId, url.searchParams.get("k") ?? "", config.secret)) {
      notice(
        response,
        403,
        "This link has expired",
        "Links to pages work for a few minutes. Open the page from the app again.",
      );
      return;
    }
    const version = await config.loadVersion(versionId);
    if (!version) {
      notice(response, 404, "This page is gone", "It was deleted in the app.");
      return;
    }
    const body = Buffer.from(injectPageRuntime(version.html, runtimeUrl), "utf8");
    response.writeHead(200, {
      ...PAGE_RESPONSE_HEADERS,
      "content-security-policy": csp,
      "content-length": String(body.length),
      // A version never changes, but the link that opened it stops working soon.
      "cache-control": "private, max-age=600",
      etag: `"${version.sha256.slice(0, 32)}"`,
    });
    response.end(head ? undefined : body);
  };
}
