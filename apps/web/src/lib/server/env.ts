import "server-only";

export const serverEnv = {
  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  workerUrl: process.env.WORKER_URL ?? "http://127.0.0.1:4001",
  workerSecret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
  workerWsUrl: process.env.NEXT_PUBLIC_WORKER_WS_URL ?? "ws://localhost:4001",
  /** The pages service, on an origin of its own, and the secret its links are signed with. */
  pagesUrl: (process.env.PAGES_URL ?? "http://127.0.0.1:3400").replace(/\/+$/, ""),
  pagesSecret:
    process.env.PAGES_SECRET ??
    (process.env.NODE_ENV === "production" ? "" : "dev-pages-secret-change-me-0123456789"),
  encryptionKey: process.env.ENCRYPTION_KEY ?? "ZGV2LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmc=",
};
