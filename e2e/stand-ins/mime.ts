import { randomUUID } from "node:crypto";
import { id16 } from "./http";

// ---------------------------------------------------------------------------------------------
// MIME, as far as Gmail's resources need it

export interface MimePart {
  headers: { name: string; value: string }[];
  mimeType: string;
  filename: string;
  /** Decoded content, for leaf parts. */
  content: Buffer;
  parts: MimePart[];
}

function decodeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g,
    (_match, _charset: string, encoding: string, text: string) =>
      encoding.toLowerCase() === "b"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text
              .replace(/_/g, " ")
              .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            "latin1",
          ).toString("utf8"),
  );
}

function splitHead(raw: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  return match
    ? { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) }
    : { head: raw, body: "" };
}

function headerList(head: string): { name: string; value: string }[] {
  return head
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0
        ? [{ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }]
        : [];
    });
}

function withParams(value: string | undefined): { value: string; params: Record<string, string> } {
  const [first = "", ...rest] = (value ?? "").split(";");
  const params: Record<string, string> = {};
  for (const entry of rest) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    params[entry.slice(0, equals).trim().toLowerCase()] = entry
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return { value: first.trim().toLowerCase(), params };
}

function decodeContent(text: string, encoding: string | undefined): Buffer {
  const kind = (encoding ?? "").trim().toLowerCase();
  if (kind === "base64") return Buffer.from(text.replace(/\s+/g, ""), "base64");
  if (kind === "quoted-printable")
    return Buffer.from(
      text
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      "latin1",
    );
  return Buffer.from(text, "utf8");
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed === `${delimiter}--`) {
      if (current) parts.push(current.join("\r\n"));
      current = null;
      break;
    }
    if (trimmed === delimiter) {
      if (current) parts.push(current.join("\r\n"));
      current = [];
      continue;
    }
    current?.push(line);
  }
  if (current) parts.push(current.join("\r\n"));
  return parts;
}

export function parseMime(raw: string): MimePart {
  const { head, body } = splitHead(raw);
  const headers = headerList(head);
  const get = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name)?.value;
  const type = withParams(get("content-type") ?? "text/plain");
  const disposition = withParams(get("content-disposition"));
  const filename = decodeWords(disposition.params.filename ?? type.params.name ?? "");
  if (type.value.startsWith("multipart/") && type.params.boundary)
    return {
      headers,
      mimeType: type.value,
      filename,
      content: Buffer.alloc(0),
      parts: splitMultipart(body, type.params.boundary).map(parseMime),
    };
  return {
    headers,
    mimeType: type.value || "text/plain",
    filename,
    content: decodeContent(body, get("content-transfer-encoding")),
    parts: [],
  };
}

/** A header of a message or part, decoded. */
export function headerOf(part: MimePart, name: string): string {
  const wanted = name.toLowerCase();
  return decodeWords(
    part.headers.find((entry) => entry.name.toLowerCase() === wanted)?.value ?? "",
  );
}

/** A raw message's text, as a reader sees it. */
export function messageText(raw: string): string {
  return plainText(parseMime(raw));
}

export function plainText(part: MimePart): string {
  if (part.parts.length) {
    const texts = part.parts.map(plainText).filter(Boolean);
    return part.mimeType === "multipart/alternative" ? (texts[0] ?? "") : texts.join("\n");
  }
  if (part.filename) return "";
  if (part.mimeType === "text/plain") return part.content.toString("utf8");
  if (part.mimeType === "text/html")
    return part.content
      .toString("utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return "";
}

function wrap76(text: string): string {
  return text.replace(/.{76}/g, "$&\r\n");
}

export interface SeedAttachment {
  name: string;
  mimeType: string;
  content: string | Buffer;
}

/** A message for the mailbox, written as a sender's mail app would. */
export interface SeedMessage {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  date?: Date;
  /** Reply in this thread. */
  threadId?: string;
  inReplyTo?: string;
  /** Default INBOX and UNREAD. */
  labels?: string[];
  attachments?: SeedAttachment[];
  messageId?: string;
}

export function composeRaw(seed: SeedMessage, owner: string): { raw: string; messageId: string } {
  const messageId = seed.messageId ?? `<${randomUUID()}@${seed.from.split("@")[1] ?? "e2e.test"}>`;
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(seed.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64")),
  ].join("\r\n");
  let content = textPart;
  if (seed.html) {
    const boundary = `alt-${id16()}`;
    content = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      textPart,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      seed.html,
      `--${boundary}--`,
    ].join("\r\n");
  }
  if (seed.attachments?.length) {
    const boundary = `mixed-${id16()}`;
    content = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      content,
      ...seed.attachments.flatMap((attachment) => [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${attachment.name}"`,
        `Content-Disposition: attachment; filename="${attachment.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(Buffer.from(attachment.content).toString("base64")),
      ]),
      `--${boundary}--`,
    ].join("\r\n");
  }
  const headers = [
    `From: ${seed.from}`,
    `To: ${(seed.to ?? [owner]).join(", ")}`,
    ...(seed.cc?.length ? [`Cc: ${seed.cc.join(", ")}`] : []),
    `Subject: ${seed.subject}`,
    `Date: ${(seed.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(seed.inReplyTo ? [`In-Reply-To: ${seed.inReplyTo}`, `References: ${seed.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  return { raw: `${headers.join("\r\n")}\r\n${content}`, messageId };
}
