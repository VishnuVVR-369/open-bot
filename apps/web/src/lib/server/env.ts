import "server-only";
import { assertNoDevSecrets, DEV_SECRETS } from "@open-bot/domain/server";

export const serverEnv = {
  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),
  /** Where the app is served. Passkeys are bound to its hostname. */
  baseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  /**
   * SHA-256 fingerprints of the certificates the Android app is signed with, comma-separated, as
   * `keytool -list` prints them. Only the release key belongs there in production.
   */
  androidCertSha256: process.env.ANDROID_CERT_SHA256,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  workerUrl: process.env.WORKER_URL ?? "http://127.0.0.1:4001",
  workerSecret: process.env.WORKER_SECRET ?? DEV_SECRETS.WORKER_SECRET,
  workerWsUrl: process.env.NEXT_PUBLIC_WORKER_WS_URL ?? "ws://localhost:4001",
  /** The pages service, on an origin of its own, and the secret its links are signed with. */
  pagesUrl: (process.env.PAGES_URL ?? "http://127.0.0.1:3400").replace(/\/+$/, ""),
  pagesSecret: process.env.PAGES_SECRET ?? DEV_SECRETS.PAGES_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY ?? DEV_SECRETS.ENCRYPTION_KEY,
  /** Signs sessions. Unset, the sign-in library reads it itself, and refuses its own default in production. */
  betterAuthSecret: process.env.BETTER_AUTH_SECRET || undefined,
  /** Google's sign-in under another base, for a stand-in in tests. Set the same in the worker. */
  googleBaseUrl: process.env.GOOGLE_BASE_URL,
  /** Notion's MCP server, for a stand-in in tests. Set the same in the worker. */
  notionMcpUrl: process.env.NOTION_MCP_URL,
};

/**
 * Refuses to serve in production with a public development secret, or a pages secret the pages
 * service would refuse. Runs at server start.
 */
export function checkProductionSecrets(nodeEnv = process.env.NODE_ENV): void {
  assertNoDevSecrets(
    {
      WORKER_SECRET: serverEnv.workerSecret,
      ENCRYPTION_KEY: serverEnv.encryptionKey,
      PAGES_SECRET: serverEnv.pagesSecret,
      BETTER_AUTH_SECRET: serverEnv.betterAuthSecret,
    },
    nodeEnv,
  );
  if (nodeEnv === "production" && serverEnv.pagesSecret.length < 32)
    throw new Error(
      "Set PAGES_SECRET to at least 32 characters, the same value as the pages service's.",
    );
}
