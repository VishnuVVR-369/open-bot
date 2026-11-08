import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { WORKER_SECRET_HEADER } from "@open-bot/api/worker";
import { MAX_UPLOAD_BYTES } from "@open-bot/domain";
import { z } from "zod";
import { errorMessage } from "./logger";
import { createRpcHandler } from "./rpc/handler";
import { createWorkerRouter, type WorkerServices } from "./rpc/router";
import { rpcError, toRpcError } from "./rpc/errors";
import { handleUpgrades } from "./ws";

export type HttpDeps = WorkerServices;

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sameSecret(a: string | string[] | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A raw request body, like a file being uploaded. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw rpcError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const UPLOAD_PATH = /^\/internal\/uploads\/([^/]+)$/;

const uploadMeta = z.object({
  name: z.string().trim().min(1, "The file needs a name.").max(255),
  mime: z.string().max(255),
  size: z.coerce.number().int().nonnegative(),
  sha256: z.string(),
});

/**
 * The worker's HTTP server: `/healthz`, the internal API (`workerContract`) for the web app, the
 * raw upload route, and the WebSockets in `ws.ts`. Everything but `/healthz` and the WebSockets
 * (which check their own signed tokens) needs `x-worker-secret`.
 */
export function createHttpServer(deps: HttpDeps): http.Server {
  const { ctx } = deps;
  const rpc = createRpcHandler(createWorkerRouter(deps), ctx);

  /**
   * `PUT /internal/uploads/{id}`: an attachment for a message, as raw bytes, outside the contract
   * so it streams instead of being parsed; see UploadService. Retries reuse the id.
   */
  async function putUpload(request: IncomingMessage, response: ServerResponse, id: string) {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? decodeURIComponent(value) : "";
    };
    const work = async () => {
      if (!z.string().uuid().safeParse(id).success) throw rpcError(404, "Not found");
      const meta = uploadMeta.safeParse({
        name: header("x-upload-name"),
        mime: header("x-upload-mime") || "application/octet-stream",
        size: header("x-upload-size"),
        sha256: header("x-upload-sha256").toLowerCase(),
      });
      if (!meta.success) throw rpcError(400, meta.error.issues.map((i) => i.message).join("; "));
      const data = await readBody(request, MAX_UPLOAD_BYTES + 1024);
      return deps.uploads.put({ id, ...meta.data, data });
    };
    const cancelled = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) cancelled.abort(new Error("Request cancelled"));
    });
    try {
      const path = `/internal/uploads/${id}`;
      send(
        response,
        200,
        await (ctx.lifecycle ? ctx.lifecycle.run(path, work, cancelled.signal) : work()),
      );
    } catch (error) {
      const failure = toRpcError(error);
      if (failure.status >= 500) ctx.log.error("upload failed", { id, error: errorMessage(error) });
      send(response, failure.status, { error: failure.message, code: failure.code });
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://worker");
    if (url.pathname === "/healthz") {
      send(response, 200, { ok: true });
      return;
    }
    if (!sameSecret(request.headers[WORKER_SECRET_HEADER], ctx.env.WORKER_SECRET)) {
      send(response, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    const upload = request.method === "PUT" ? UPLOAD_PATH.exec(url.pathname) : null;
    if (upload) {
      await putUpload(request, response, decodeURIComponent(upload[1]!));
      return;
    }
    const { matched } = await rpc.handle(request, response, { context: { path: url.pathname } });
    if (!matched) send(response, 404, { error: "not found", code: "NOT_FOUND" });
  });

  handleUpgrades(server, ctx, deps.egress);
  return server;
}
