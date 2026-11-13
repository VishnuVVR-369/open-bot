import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export const OUR_TOKEN = /^e2e-/;

export const HOUR = 3600;

export const id16 = () => randomBytes(8).toString("hex");

export const token = (kind: string) => `e2e-${kind}-${randomBytes(18).toString("base64url")}`;

export const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

export interface Exchange {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  body: Buffer;
  /** Do the work, then cut the connection instead of answering: an answer lost on the way. */
  drop: boolean;
}

/** A failure a test plans: the next matching request(s) get it. */
export interface Fault {
  method?: string;
  path: RegExp;
  /** Answer this instead of handling the request. */
  status?: number;
  body?: unknown;
  /** Handle the request, then cut the connection: the client can't tell if it happened. */
  drop?: boolean;
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  query: Record<string, string>;
  at: number;
}

export function send(
  ex: Exchange,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
) {
  if (ex.drop) {
    ex.res.socket?.destroy();
    return;
  }
  ex.res.writeHead(status, headers);
  ex.res.end(body);
}

export function json(
  ex: Exchange,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  send(ex, status, JSON.stringify(body), { "content-type": "application/json", ...headers });
}

export function empty(ex: Exchange, status = 204) {
  send(ex, status, "");
}

export function redirect(ex: Exchange, location: string) {
  send(ex, 302, "", { location });
}

export function page(ex: Exchange, status: number, title: string, text: string) {
  send(
    ex,
    status,
    `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${text}</p>`,
    { "content-type": "text/html; charset=utf-8" },
  );
}

export function form(ex: Exchange): URLSearchParams {
  return new URLSearchParams(ex.body.toString("utf8"));
}

export function jsonBody(ex: Exchange): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(ex.body.toString("utf8") || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function bearer(ex: Exchange): string | null {
  const header = ex.req.headers.authorization ?? "";
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
}
