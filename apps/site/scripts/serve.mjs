// A small static file server for local work: the built site (`pnpm start`) and the encoded media (`pnpm media:serve`).
// It answers range requests so video seeks work, sends CORS headers the way the R2 bucket does,
// and applies a Cloudflare Pages _headers file when the directory has one, so tests see the real CSP.
//
// Usage: node scripts/serve.mjs <dir> <port>
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const [dir = "out", port = "3200"] = process.argv.slice(2);
const root = resolve(dir);

/** Parses a Cloudflare Pages _headers file: a path pattern, then its indented "Name: value" lines. */
async function loadHeaderRules() {
  const text = await readFile(join(root, "_headers"), "utf8").catch(() => "");
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      rules.push({ match: new RegExp(`^${pattern}$`), headers: [] });
    } else if (rules.length) {
      const at = line.indexOf(":");
      rules.at(-1).headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}
const headerRules = await loadHeaderRules();

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".vtt": "text/vtt; charset=utf-8",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".m3u8": "application/vnd.apple.mpegurl",
};

async function find(pathname) {
  const path = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
    const file = join(root, candidate);
    if (!file.startsWith(root)) return null;
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) return { file, size: info.size };
  }
  return null;
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  for (const rule of headerRules) {
    if (rule.match.test(pathname))
      for (const [name, value] of rule.headers) res.setHeader(name, value);
  }
  let found = await find(pathname);
  let status = 200;
  if (!found) {
    found = await find("/404.html");
    status = 404;
    if (!found) return res.writeHead(404).end("Not found");
  }

  const { file, size } = found;
  res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(status, { "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`Serving ${root} on http://localhost:${port}`));
