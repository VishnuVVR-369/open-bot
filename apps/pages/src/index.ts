import http from "node:http";
import { createDb, createPool, pageVersions } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { readEnv, type PagesEnv } from "./env";
import { createPagesHandler } from "./server";

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

let env: PagesEnv;
try {
  env = readEnv();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const { port, secret, origin, appOrigins, libDir } = env;

const pool = createPool(env.databaseUrl);
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
