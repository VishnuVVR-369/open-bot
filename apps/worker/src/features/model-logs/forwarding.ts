// What the model proxy's HTTP and WebSocket paths share: which headers cross a hop, and which
// Codex threads a request names.
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { type HeaderBag, headerValue, turnMetadata } from "@open-bot/domain";

/** Request bodies past this are forwarded but not logged. Codex's largest are a few MB. */
export const REQUEST_BODY_LIMIT = 32 * 1024 * 1024;

/** Headers that belong to one connection, never forwarded (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The Codex threads a request names: its own, and the parent of a sub-agent's. */
export function threadIdsOf(
  headers: IncomingHttpHeaders | HeaderBag,
  body: unknown = null,
): string[] {
  const ids = [
    headerValue(headers, "thread-id"),
    headerValue(headers, "x-codex-parent-thread-id"),
    turnMetadata(headers, body).threadId,
  ];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/**
 * Forwardable headers from Node's raw list, as name and value pairs: hop-by-hop ones, those the
 * `Connection` header names, and those `drop` names are left out.
 */
export function forwardable(
  raw: string[],
  drop: ReadonlySet<string> | ((name: string) => boolean) = new Set(),
): string[] {
  const dropped = typeof drop === "function" ? drop : (name: string) => drop.has(name);
  const listed = new Set<string>();
  for (let at = 0; at < raw.length; at += 2)
    if (raw[at]!.toLowerCase() === "connection")
      for (const name of raw[at + 1]!.split(",")) listed.add(name.trim().toLowerCase());
  const out: string[] = [];
  for (let at = 0; at < raw.length; at += 2) {
    const name = raw[at]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name) || dropped(name)) continue;
    out.push(raw[at]!, raw[at + 1]!);
  }
  return out;
}

export function sameToken(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sendJson(response: ServerResponse, status: number, type: string, message: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type, message } }));
}
