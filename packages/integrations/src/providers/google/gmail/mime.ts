import { randomUUID } from "node:crypto";

/** Building and reading RFC 5322 messages, as Gmail's API takes and returns them. */

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** The Message-ID this answers, for threading. */
  inReplyTo?: string | null;
  references?: string | null;
  /** Our own, so a send can be found again in Sent if its answer is lost. */
  messageId: string;
}

export function newMessageId(domain = "open-bot.local"): string {
  return `<${randomUUID()}@${domain}>`;
}

/** A header value with non-ASCII text, as an RFC 2047 encoded word. */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Addresses can't carry line breaks: a header injection would add recipients. */
function addressList(addresses: string[]): string {
  return addresses.map((address) => address.replace(/[\r\n]+/g, " ").trim()).join(", ");
}

/** The message as RFC 5322 text, plain text in UTF-8. */
export function buildMime(message: OutgoingMessage): string {
  const headers = [
    `From: ${encodeHeader(message.from)}`,
    `To: ${addressList(message.to)}`,
    ...(message.cc.length ? [`Cc: ${addressList(message.cc)}`] : []),
    ...(message.bcc.length ? [`Bcc: ${addressList(message.bcc)}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Message-ID: ${message.messageId}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.inReplyTo || message.references
      ? [`References: ${[message.references, message.inReplyTo].filter(Boolean).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(message.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function toBase64Url(text: string | Buffer): string {
  return Buffer.from(text).toString("base64url");
}

export function fromBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** The header block of a raw message, unfolded, as name (lower case) to values. */
export function parseHeaders(raw: string): Map<string, string[]> {
  const end = raw.search(/\r?\n\r?\n/);
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string[]>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = decodeHeader(line.slice(colon + 1).trim());
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return headers;
}

/** RFC 2047 encoded words (=?UTF-8?B?…?= and =?UTF-8?Q?…?=) as text. */
export function decodeHeader(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g,
    (_match, charset: string, encoding: string, text: string) => {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text
                .replace(/_/g, " ")
                .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
              "latin1",
            );
      try {
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return bytes.toString("utf8");
      }
    },
  );
}

/** Split a header's address list on commas outside quotes and angle brackets. */
export function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angle += 1;
    else if (char === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (char === "," && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Add a Message-ID to a raw message that has none (drafts written in Gmail's own app). */
export function ensureMessageId(
  raw: string,
  messageId: string,
): { raw: string; messageId: string } {
  const existing = parseHeaders(raw).get("message-id")?.[0];
  if (existing) return { raw, messageId: existing };
  return { raw: `Message-ID: ${messageId}\r\n${raw}`, messageId };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  zwnj: "",
  zwj: "",
};

/** Elements whose content is never shown as text. */
const UNSHOWN = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
  "svg",
  "noscript",
  "object",
]);
/** Elements with no closing tag. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
/** Elements that end a line. */
const BLOCK = new Set([
  "p",
  "div",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "section",
  "article",
  "table",
  "ul",
  "ol",
  "header",
  "footer",
  "pre",
]);
/** Inline styles and attributes that keep an element from being seen. */
const HIDDEN =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d]*[1-9])|max-height\s*:\s*0(?![.\d]*[1-9])|opacity\s*:\s*0(?![.\d]*[1-9])|(?:^|\s)hidden(?=[\s=/]|$)/i;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000
        ? String.fromCodePoint(value)
        : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * HTML mail as readable text: blocks become lines, links keep their address, and what a reader
 * can't see (styles, scripts, hidden elements, tracking pixels) is dropped, since hidden text is a
 * classic way to slip instructions past a person. Tags are walked with their nesting, so a hidden
 * element stays hidden however much is inside it.
 */
export function htmlToText(html: string): string {
  let out = "";
  /** While set, everything up to this element's end is unseen. */
  let skip: { name: string; depth: number } | null = null;
  const links: { start: number; href: string }[] = [];
  const tokens = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)|</gi;
  for (const token of html.matchAll(tokens)) {
    const [whole, closing, rawName, attributes = "", text] = token;
    if (text !== undefined || whole === "<") {
      if (!skip) out += decodeEntities(text ?? whole);
      continue;
    }
    if (!rawName) continue; // a comment
    const name = rawName.toLowerCase();
    const selfClosing = VOID.has(name) || /\/\s*$/.test(attributes);
    if (skip) {
      if (name === skip.name && !selfClosing) {
        skip.depth += closing ? -1 : 1;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }
    if (closing) {
      if (name === "a") {
        const link = links.pop();
        if (link) {
          const label = out.slice(link.start).trim();
          if (label && link.href && !/^mailto:/i.test(link.href) && label !== link.href)
            out += ` (${link.href})`;
        }
      } else if (BLOCK.has(name)) out += "\n";
      continue;
    }
    if (!selfClosing && (UNSHOWN.has(name) || HIDDEN.test(attributes))) {
      skip = { name, depth: 1 };
      continue;
    }
    if (name === "br") out += "\n";
    else if (name === "li") out += "- ";
    else if (name === "a") {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      links.push({
        start: out.length,
        href: decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? ""),
      });
    }
  }
  return out
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A Gmail API message part tree. */
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface MessageContent {
  text: string;
  attachments: { id: string; partId: string; name: string; mimeType: string; size: number }[];
}

/** The readable text of a Gmail message (plain text, else HTML as text) and its attachments. */
export function messageContent(payload: GmailPart): MessageContent {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: MessageContent["attachments"] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        partId: part.partId ?? "",
        name: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
      return;
    }
    if (part.body?.data) {
      const decoded = fromBase64Url(part.body.data).toString("utf8");
      if (type === "text/plain") plain.push(decoded);
      else if (type === "text/html") html.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.length ? plain.join("\n\n") : html.map(htmlToText).join("\n\n");
  return { text: text.replace(/\r\n/g, "\n").trim(), attachments };
}

/** A raw message's text body, for an approval preview of a draft. */
export function rawBody(raw: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  if (end === -1) return "";
  const headers = parseHeaders(raw);
  const type = headers.get("content-type")?.[0] ?? "text/plain";
  const body = raw.slice(end).replace(/^\r?\n\r?\n/, "");
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary) {
    const parts = body.split(`--${boundary}`).slice(1, -1);
    const texts = parts.map((part) => ({
      type: parseHeaders(part.replace(/^\r?\n/, "")).get("content-type")?.[0] ?? "text/plain",
      text: rawBody(part.replace(/^\r?\n/, "")),
    }));
    const plain = texts.find((part) => part.type.startsWith("text/plain"));
    if (plain) return plain.text;
    const html = texts.find((part) => part.type.startsWith("text/html"));
    if (html) return htmlToText(html.text);
    return texts.map((part) => part.text).join("\n\n");
  }
  const encoding = headers.get("content-transfer-encoding")?.[0]?.toLowerCase();
  const decoded =
    encoding === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : encoding === "quoted-printable"
        ? body
            .replace(/=\r?\n/g, "")
            .replace(/=([0-9a-f]{2})/gi, (_m, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            )
        : body;
  return type.startsWith("text/html") ? htmlToText(decoded) : decoded.replace(/\r\n/g, "\n").trim();
}
