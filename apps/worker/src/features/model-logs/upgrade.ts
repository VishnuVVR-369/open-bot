// The model proxy's WebSocket handshakes: Codex's upgrade is checked before anything is opened
// upstream, and an upstream that refuses to upgrade has its answer passed on to Codex as it
// streams, the status first.
import type { IncomingMessage } from "node:http";
import { Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { forwardable } from "./forwarding";

/** Answers an upgrade with an HTTP error and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number, type: string, message: string) {
  const body = JSON.stringify({ error: { type, message } });
  socket.end(
    `HTTP/1.1 ${status} ${type}\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/** An RFC 9110 token, which a subprotocol must be (RFC 6455, section 4.1). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A `Sec-WebSocket-Key`: 16 random bytes, base64 encoded. */
const KEY = /^[+/0-9A-Za-z]{22}==$/;

/**
 * The subprotocols Codex offered, in order, or why its upgrade isn't a WebSocket handshake that
 * can be completed: the checks `ws` makes when it completes one, made before anything is opened
 * upstream, because the same values given to the upstream connection would throw.
 */
export function checkUpgrade(
  request: IncomingMessage,
): { protocols: string[] } | { problem: string } {
  if (request.method !== "GET") return { problem: "A WebSocket upgrade must be a GET." };
  if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket")
    return { problem: "The Upgrade header must be websocket." };
  if (!KEY.test(request.headers["sec-websocket-key"] ?? ""))
    return { problem: "The Sec-WebSocket-Key header is missing or invalid." };
  const version = request.headers["sec-websocket-version"];
  if (version !== "13" && version !== "8")
    return { problem: "The Sec-WebSocket-Version header must be 13 or 8." };
  const offered = request.headers["sec-websocket-protocol"];
  if (offered === undefined) return { protocols: [] };
  const protocols = offered.split(",").map((protocol) => protocol.trim());
  if (
    protocols.some((protocol) => !TOKEN.test(protocol)) ||
    new Set(protocols).size !== protocols.length
  )
    return {
      problem: "The Sec-WebSocket-Protocol header names an invalid or repeated subprotocol.",
    };
  return { protocols };
}

const CRLF = Buffer.from("\r\n");

/**
 * Passes on an upstream's answer to an upgrade it refused, as it arrives: the status and headers at
 * once, so Codex can fall back or recover without waiting, then the whole body with backpressure.
 * The body keeps the upstream's length when it gave one, else it is sent chunked. `copy` sees each
 * chunk of the body as it came, for the log. Resolves once the body was passed on whole; rejects
 * when either side broke off.
 */
export async function relayRefusal(
  response: IncomingMessage,
  socket: Duplex,
  copy: (chunk: Buffer) => void,
): Promise<void> {
  const status = response.statusCode ?? 502;
  const bodiless = status === 204 || status === 304 || status < 200;
  const chunked = response.headers["content-length"] === undefined && !bodiless;
  const head = [`HTTP/1.1 ${status} ${response.statusMessage ?? ""}`];
  const headers = forwardable(response.rawHeaders);
  for (let at = 0; at < headers.length; at += 2) head.push(`${headers[at]}: ${headers[at + 1]}`);
  if (chunked) head.push("transfer-encoding: chunked");
  head.push("connection: close", "", "");
  socket.write(head.join("\r\n"));
  const frame = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      copy(chunk);
      if (!chunked || !chunk.length) return done(null, chunk);
      done(null, Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, CRLF]));
    },
    flush(done) {
      done(null, chunked ? Buffer.from("0\r\n\r\n") : undefined);
    },
  });
  // Ends Codex's side once the body is through, as `connection: close` says.
  await pipeline(response, frame, socket);
}
