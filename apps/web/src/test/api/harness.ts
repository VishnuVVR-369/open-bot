import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS, type ApiClient } from "@open-bot/api";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, vi } from "vitest";
import { seedApi, owned } from "./seed";

export const apiTestUrl = testDatabaseServer();
export const OWNER = { id: "owner", name: "Alex Rivera", email: "alex@example.test" };
// The session check is Better Auth's; here every call is the owner's.
vi.mock("@/lib/server/auth", () => ({
  auth: { api: { getSession: async () => ({ user: OWNER, session: { id: "session-1" } }) } },
}));

/** What the stand-in worker answers, by path; anything else is a 503, like a stopped worker. */
const WORKER: Record<string, unknown> = {
  "/internal/status": {
    computer: { online: true, health: null, lifecycle: null },
    codex: { connected: true, authSource: "host", account: null, login: null, error: null },
    egress: OFFLINE_EGRESS_STATUS,
  },
  "/internal/telegram": {
    connected: false,
    botUsername: null, // vocabulary: allow
    tokenHint: null,
    linked: false,
    linkedName: null,
    problem: null,
  },
  "/internal/push": { publicKey: "key", devices: [] },
  "/internal/email": {
    domain: null,
    inboundPath: "/api/inbound/email/token",
    tokenHint: null,
    lastReceivedAt: null,
    addresses: [],
  },
  "/internal/codex/rate-limits": {
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    },
  },
};

/** Each suite owns its database, worker and module pool; no owner service is contacted. */
export function apiHarness() {
  const ids = {
    teammate: randomUUID(),
    chat: randomUUID(),
    run: randomUUID(),
    schedule: randomUUID(),
    trigger: randomUUID(),
    page: randomUUID(),
    version: randomUUID(),
    memory: "",
  };

  const database = testDatabase(apiTestUrl);
  const workerPaths: string[] = [];
  /** What the web app sent the worker, by path, newest last. */
  const workerBodies: { path: string; body: unknown }[] = [];
  /** Answers a test gives to a worker write, by path. */
  const answers = new Map<string, { status: number; body: unknown }>();
  let workerUp = true;
  const worker = http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://worker").pathname;
    workerPaths.push(path);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    workerBodies.push({ path, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    const answer = answers.get(path);
    if (answer) {
      response.statusCode = answer.status;
      response.end(JSON.stringify(answer.body));
      return;
    }
    const listing =
      path === "/internal/files/list"
        ? {
            path: "/home/bot",
            entries: [
              { name: "shared", path: "/home/bot/shared", isDirectory: true, modifiedAt: null },
            ],
          }
        : undefined;
    const body = workerUp ? (listing ?? WORKER[path]) : undefined;
    if (body === undefined) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "The computer is offline." }));
      return;
    }
    response.end(JSON.stringify(body));
  });
  let api: ApiClient;

  beforeAll(async () => {
    await database.create();
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("DATABASE_URL", database.url);
    vi.stubEnv("WORKER_URL", `http://127.0.0.1:${(worker.address() as AddressInfo).port}`);
    vi.stubEnv("WORKER_SECRET", "router-test-secret");
    vi.stubEnv("NEXT_PUBLIC_WORKER_WS_URL", "ws://worker.test");
    const { router } = await import("@/lib/server/api/router");
    api = createRouterClient(router, { context: { headers: new Headers() } }) as ApiClient;
    await seedApi(database, ids);
  });

  afterAll(async () => {
    await new Promise((resolve) => worker.close(resolve));
    const { pool } = await import("@/lib/server/db");
    await pool.end();
    await database.drop();
    vi.unstubAllEnvs();
  });

  return {
    database,
    ids,
    owned,
    workerPaths,
    workerBodies,
    answers,
    get api() {
      return api;
    },
    get workerUp() {
      return workerUp;
    },
    set workerUp(value: boolean) {
      workerUp = value;
    },
  };
}
