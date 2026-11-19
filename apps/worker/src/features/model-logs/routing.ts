// Where Codex on the computer sends model traffic when the proxy is on: the worker's own address
// as the computer reaches it, a token, and the route.
import { createHmac } from "node:crypto";
import type { ModelRoute } from "@open-bot/domain";

/** The path every proxied request starts with: `/model-proxy/<token>/<route>/...`. */
export const MODEL_PROXY_PATH = "/model-proxy/";

/** What routing reads from the worker's environment. */
export interface ModelProxyEnv {
  /** Off sends threads straight to the model, as before the proxy. */
  MODEL_PROXY: boolean;
  /** The worker as the computer reaches it, when it can't be worked out. */
  MODEL_PROXY_URL?: string | undefined;
  /** Railway's private name for this service, like `worker.railway.internal`. */
  RAILWAY_PRIVATE_DOMAIN?: string | undefined;
  WORKER_PORT: number;
  ENCRYPTION_KEY: string;
}

/**
 * The secret part of every proxy URL, derived from `ENCRYPTION_KEY` so it needs no variable of
 * its own. It keeps the rest of the private network (web, pages) out; it is not what lets a
 * request spend the API key (see `ModelProxy`).
 */
export function modelProxyToken(encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update("model-proxy").digest("hex");
}

/**
 * The worker's address from the computer: `MODEL_PROXY_URL` when set, Railway's private network
 * on Railway, and otherwise the Docker host, where a local computer container finds the worker.
 */
export function workerUrlFromComputer(env: ModelProxyEnv): string {
  if (env.MODEL_PROXY_URL) return env.MODEL_PROXY_URL.replace(/\/+$/, "");
  const host = env.RAILWAY_PRIVATE_DOMAIN || "host.docker.internal";
  return `http://${host}:${env.WORKER_PORT}`;
}

/** The base URL Codex is given for a route, or null when the proxy is off. */
export function modelProxyUrl(env: ModelProxyEnv, route: ModelRoute): string | null {
  if (!env.MODEL_PROXY) return null;
  return `${workerUrlFromComputer(env)}${MODEL_PROXY_PATH}${modelProxyToken(env.ENCRYPTION_KEY)}/${route}`;
}
