import "server-only";

export const serverEnv = {
  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  workerUrl: process.env.WORKER_URL ?? "http://127.0.0.1:4001",
  workerSecret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
  workerWsUrl: process.env.NEXT_PUBLIC_WORKER_WS_URL ?? "ws://localhost:4001",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "ZGV2LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmc=",
};
