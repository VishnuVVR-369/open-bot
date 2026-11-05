import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

/**
 * Serving /lib (Node only): the pages service and the computer's preview server answer the same
 * way, so a page loads the same libraries with the same headers wherever it opens.
 */

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
};

export interface LibFile {
  data: Buffer;
  headers: Record<string, string>;
}

/**
 * A file under `libDir` for a request path like `/lib/kit@1/page.css`, or null when there's no
 * such file (or the path tries to leave the folder).
 */
export async function readLibFile(libDir: string, pathname: string): Promise<LibFile | null> {
  if (!pathname.startsWith("/lib/")) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/lib/".length));
  } catch {
    return null;
  }
  if (!relative || relative.includes("\0") || relative.split("/").some((part) => part === ".."))
    return null;
  const type = TYPES[extname(relative).toLowerCase()];
  if (!type) return null;
  const root = await realpath(libDir);
  let path: string;
  try {
    path = await realpath(join(root, relative));
  } catch {
    return null;
  }
  if (!path.startsWith(root + sep)) return null;
  const info = await stat(path);
  if (!info.isFile()) return null;
  const data = await readFile(path);
  return {
    data,
    headers: {
      "content-type": type,
      "content-length": String(data.length),
      etag: `"${createHash("sha256").update(data).digest("base64url").slice(0, 22)}"`,
      // Libraries change only with a deploy; an hour of caching keeps pages fast without going stale.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      // Pages run with an opaque origin, and fonts load with CORS, so anyone may read these.
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    },
  };
}
