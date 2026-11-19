// Header objects in what the model sent back, made safe to store. A WebSocket event or an error
// envelope can carry the answer's headers (`{"headers": {"set-cookie": ...}}`), and those are
// stored the way the request's own headers are: without credentials or the account. Nothing here
// recurses, so however deep an upstream nests its JSON, reading it can't overflow the stack.
import { isAccountHeader, isSecretHeader } from "./headers";

/**
 * How deep JSON may nest and still be stored as JSON: deeper than this, a value is too deep to
 * walk or serialize safely, so it is left out with a warning.
 */
export const MAX_JSON_DEPTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON value nests deeper than `max` objects and lists, found without recursion. */
export function nestedDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [next, depth] = stack.pop()!;
    if (typeof next !== "object" || next === null) continue;
    if (depth + 1 > max) return true;
    for (const child of Array.isArray(next) ? next : Object.values(next))
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * JSON text for a value, with every header object in it (the value of a `headers` key, in any
 * case, at any depth) stripped: an object loses the entries `sanitizeHeaders` leaves out, and
 * anything else under that key (a list, a string) is left out whole. `changed` says whether
 * anything was. Null when the value nests deeper than `MAX_JSON_DEPTH`.
 */
export function redactedJson(value: unknown): { text: string; changed: boolean } | null {
  if (nestedDeeperThan(value, MAX_JSON_DEPTH)) return null;
  let changed = false;
  const text = JSON.stringify(value, function (this: unknown, key: string, entry: unknown) {
    if (key.toLowerCase() !== "headers" || !isRecord(this)) return entry;
    if (!isRecord(entry)) {
      changed = true;
      return undefined;
    }
    const kept: Record<string, unknown> = {};
    for (const [name, header] of Object.entries(entry))
      if (isSecretHeader(name) || isAccountHeader(name)) changed = true;
      else kept[name] = header;
    return kept;
  });
  return { text: text ?? "null", changed };
}

/** A quoted string followed by a colon: what a key looks like, whether or not the text is JSON. */
const KEY = /"((?:[^"\\]|\\.)*)"\s*:/g;
/** A `headers` key written plainly. */
const HEADERS_KEY = /"headers"\s*:/i;

/**
 * Where the first `headers` key starts in text, or -1. It looks at anything shaped like a key,
 * escaped or not, so it finds one in text that isn't whole JSON too.
 */
export function headersKeyAt(text: string): number {
  let at = text.search(HEADERS_KEY);
  // A key spelled with escapes (`"headers"`) is the same key once read.
  if (!text.includes("\\")) return at;
  for (const match of text.matchAll(KEY)) {
    if (at !== -1 && match.index >= at) break;
    const key = match[1]!;
    if (!key.includes("\\")) continue;
    let read: unknown;
    try {
      read = JSON.parse(`"${key}"`);
    } catch {
      continue;
    }
    if (typeof read === "string" && read.toLowerCase() === "headers") at = match.index;
  }
  return at;
}

/**
 * One message, event or body made safe to store. With no `headers` key it is kept byte for byte.
 * Read whole, its header objects are stripped (`redactedJson`). Unreadable (cut short, not JSON,
 * or nested deeper than `MAX_JSON_DEPTH`), everything from its first `headers` key to its end is
 * left out, and `cut` says so.
 */
function redactUnit(text: string): { text: string; cut: boolean } {
  const at = headersKeyAt(text);
  if (at === -1) return { text, cut: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text: text.slice(0, at), cut: true };
  }
  const redacted = redactedJson(value);
  if (!redacted) return { text: text.slice(0, at), cut: true };
  return { text: redacted.changed ? redacted.text : text, cut: false };
}

/** Lines with their endings, which may be `\n`, `\r\n` or `\r`; the last may have none. */
function linesOf(text: string): { line: string; end: string }[] {
  const lines: { line: string; end: string }[] = [];
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (match[0] === "" && match.index === text.length) break;
    lines.push({ line: match[1]!, end: match[2]! });
  }
  return lines;
}

/** One SSE event's lines made safe to store: its data as one unit, every other line on its own. */
function redactEvent(lines: { line: string; end: string }[]): { text: string; cut: boolean } {
  const original = lines.map(({ line, end }) => line + end).join("");
  const isData = (line: string) => line === "data" || line.startsWith("data:");
  const data = lines
    .filter(({ line }) => isData(line))
    .map(({ line }) => line.slice(5).replace(/^ /, ""));
  const payload = redactUnit(data.join("\n"));
  let cut = payload.cut;
  let changed = payload.text !== data.join("\n");
  const out: string[] = [];
  let dataWritten = false;
  for (const { line, end } of lines) {
    if (!isData(line)) {
      // Not read as the event's data, but stored all the same: an `event:` name or a comment.
      const at = headersKeyAt(line);
      if (at !== -1) {
        out.push(line.slice(0, at) + end);
        cut = changed = true;
      } else out.push(line + end);
      continue;
    }
    if (dataWritten) continue;
    dataWritten = true;
    // The data, redacted, where its first line was; what an unreadable one held past its
    // `headers` key is gone, the lines after it included.
    // It ends as the last data line did: a stream cut short may not end that line.
    const last = lines.findLast(({ line }) => isData(line))!.end;
    const kept = payload.text.split("\n");
    kept.forEach((piece, index) =>
      out.push(`data: ${piece}${index < kept.length - 1 ? "\n" : last}`),
    );
  }
  return { text: changed ? out.join("") : original, cut };
}

/** An SSE body made safe to store, event by event; events end at a blank line. */
function redactEventStream(text: string): { text: string; cut: boolean } {
  const out: string[] = [];
  let cut = false;
  let event: { line: string; end: string }[] = [];
  const flush = () => {
    if (!event.length) return;
    const redacted = redactEvent(event);
    out.push(redacted.text);
    cut ||= redacted.cut;
    event = [];
  };
  for (const line of linesOf(text)) {
    event.push(line);
    if (line.line === "") flush();
  }
  flush();
  return { text: out.join(""), cut };
}

/**
 * A response as it came, made safe to store, keeping where each message, event or body begins and
 * ends: `raw` as WebSocket messages, each read on its own, or an HTTP body, read event by event
 * when it is an event stream and whole otherwise. In each, header objects lose their credentials
 * and the account (`redactedJson`). One that can't be read whole loses everything from its first
 * `headers` key to its own end, and `cut` says something did. What has no `headers` key is kept
 * byte for byte.
 */
export function redactRawResponse(
  raw: string | readonly string[],
  contentType: string | null,
): { text: string; cut: boolean } {
  if (typeof raw !== "string") {
    const messages = raw.map(redactUnit);
    return {
      text: messages.map((message) => message.text).join("\n"),
      cut: messages.some((message) => message.cut),
    };
  }
  const stream =
    contentType?.includes("text/event-stream") || /^(event:|data:|:)/.test(raw.trimStart());
  return stream ? redactEventStream(raw) : redactUnit(raw);
}
