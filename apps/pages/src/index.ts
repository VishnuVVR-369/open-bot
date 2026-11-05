import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createDb, createPool, pageVersions } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { createPagesHandler } from "./server";

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

const port = Number(process.env.PORT ?? 3400);
/** Shared with the web app. The development default works only outside production. */
const secret =
  process.env.PAGES_SECRET ??
  (process.env.NODE_ENV === "production" ? "" : "dev-pages-secret-change-me-0123456789");
if (secret.length < 32) {
  log("PAGES_SECRET must be set to at least 32 characters (the same value as the web app's)");
  process.exit(1);
}

/** This service's own address: set, or Railway's public domain, or the local one. */
const origin =
  process.env.PAGES_URL?.replace(/\/+$/, "") ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://127.0.0.1:${port}`);

/** The app may show pages in a frame; nothing else may. */
const appOrigins = (process.env.APP_URL ?? "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => new URL(value).origin);

/** /lib: next to the built server, or the page kit's build when running from source. */
const libDir =
  process.env.PAGE_LIB_DIR ??
  [
    new URL("./lib", import.meta.url),
    new URL("../../../packages/page-kit/dist/lib", import.meta.url),
  ]
    .map((url) => fileURLToPath(url))
    .find((path) => existsSync(path));
if (!libDir) {
  log("The page kit isn't built: run pnpm --filter @open-bot/page-kit build");
  process.exit(1);
}

const pool = createPool();
const db = createDb(pool);

const handler = createPagesHandler({
  origin,
  appOrigins,
  secret,
  libDir,
  async loadVersion(versionId) {
    const [row] = await db
      .select({ html: pageVersions.html, sha256: pageVersions.sha256 })
      .from(pageVersions)
      .where(eq(pageVersions.id, versionId));
    return row ?? null;
  },
  log,
});

const server = http.createServer((request, response) => {
  handler(request, response).catch((error: unknown) => {
    log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
    response.end("Something went wrong.");
  });
});
server.listen(port, () =>
  log(`pages listening on :${port} as ${origin}, framed by ${appOrigins.join(", ")}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    void pool.end().finally(() => process.exit(0));
  });
}
