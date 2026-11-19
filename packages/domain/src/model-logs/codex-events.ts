// What open-bot keeps of the Codex app-server stream: which messages are streaming deltas (counted,
// never stored), which thread, turn and item a message is about, and the redaction every stored
// payload goes through so no credential is ever written.
import { MAX_JSON_DEPTH } from "./redact";
import { isSecretKey, normalizedKey, REDACTED, redactSecretText } from "./secret-text";

/** What everything a credentials file could have leaked into is replaced with. */
export const CREDENTIAL_FILE_REDACTED = "[redacted: it reads or writes a credentials file]";

/** The longest string kept in a payload; past it the rest is cut, with a note of how much. */
export const MAX_EVENT_STRING = 1024 * 1024;

/**
 * The largest message, as JSON text, whose payload is redacted and stored. Past it only a stub is
 * stored, so a huge tool result never costs the worker more than this to read.
 */
export const MAX_EVENT_SIZE = 2 * 1024 * 1024;

/** The most objects, lists and values one payload may hold and still be stored. */
export const MAX_EVENT_NODES = 50_000;

/** Why a payload could not be redacted, so it is stored as a stub and counted as lost. */
export class UnstorablePayload extends Error {
  override name = "UnstorablePayload";
}

/**
 * A streaming delta: a piece of an item still being built (`item/agentMessage/delta`,
 * `item/commandExecution/outputDelta`, ...). The completed item carries all of it, so deltas are
 * counted, never stored.
 */
export function isDeltaMethod(method: string): boolean {
  return /delta$/i.test(method);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The thread, turn and item a message is about, as far as it says. */
export interface CodexEventRefs {
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
}

/**
 * The refs in a message's params (a request or notification) or result (a response).
 * Items are named by `itemId`, by the item itself, or by `callId` for a dynamic tool call, which
 * Codex gives the same id as its item.
 */
export function codexEventRefs(payload: unknown): CodexEventRefs {
  if (!isRecord(payload)) return { threadId: null, turnId: null, itemId: null };
  const thread = isRecord(payload.thread) ? payload.thread : {};
  const turn = isRecord(payload.turn) ? payload.turn : {};
  const item = isRecord(payload.item) ? payload.item : {};
  return {
    threadId: str(payload.threadId) ?? str(thread.id) ?? str(payload.conversationId),
    turnId: str(payload.turnId) ?? str(turn.id) ?? str(payload.expectedTurnId),
    itemId: str(payload.itemId) ?? str(item.id) ?? str(payload.callId),
  };
}

/**
 * Methods whose every message is sign-in material: the login itself and the ChatGPT token refresh
 * Codex asks the worker for. Every string in them is redacted except the keys below.
 */
const AUTH_METHODS = new Set([
  "account/login/start",
  "account/chatgptAuthTokens/refresh",
  "getAuthStatus",
]);
const AUTH_KEPT_KEYS = new Set(["type", "reason", "chatgptPlanType"]);

/**
 * Keys whose value maps names to secrets: MCP servers' and providers' HTTP headers and
 * environment. The names are kept, every value is redacted.
 */
const SECRET_MAPS = new Set(["env", "headers", "httpheaders", "envhttpheaders"]);

/**
 * Files that hold credentials, by where they live under a home directory: Codex's own login,
 * `.netrc`, git, Postgres, npm and PyPI credentials, cloud CLIs' logins, Docker and Kubernetes
 * configs, SSH and GPG keys, and `.env` files.
 */
const CREDENTIAL_FILE =
  /(?:^|[^A-Za-z0-9_-])(?:\.codex\/auth\.json|\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.aws\/(?:credentials|config)|\.config\/gcloud\/|\.azure\/|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts\.ya?ml|\.ssh\/id_[A-Za-z0-9_]+|\.gnupg\/|\.env(?:\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_/-]))/;

/** The keys in an item or request that name what it runs or touches. */
const TARGET_KEYS = new Set(["command", "path", "file", "filepath", "filename", "argv"]);

/** Keys still kept when an item touches a credentials file: what it is, and what it touched. */
const KEPT_ON_CREDENTIAL_FILE = new Set([
  "type",
  "id",
  "status",
  "kind",
  "cwd",
  "path",
  "tool",
  "server",
  "name",
  "namespace",
  "source",
]);

/**
 * A command that reads or writes a credentials file, as it is stored: only the files it names.
 * The command itself can hold what it writes there, so none of it is kept.
 */
function credentialCommand(command: unknown): string {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  const files = new Set<string>();
  for (const match of text.matchAll(new RegExp(CREDENTIAL_FILE.source, "g")))
    files.add(match[0].replace(/^[^.~_]/, ""));
  return `[redacted: a command that reads or writes ${[...files].join(", ") || "a credentials file"}]`;
}

/** Whether an object runs or touches a credentials file, judged by its own target keys. */
function touchesCredentialFile(value: Record<string, unknown>): boolean {
  for (const [key, inner] of Object.entries(value)) {
    if (!TARGET_KEYS.has(normalizedKey(key))) continue;
    const targets = Array.isArray(inner) ? inner : [inner];
    if (targets.some((target) => typeof target === "string" && CREDENTIAL_FILE.test(target)))
      return true;
  }
  return false;
}

function redactString(value: string): string {
  const out =
    value.length > MAX_EVENT_STRING
      ? `${value.slice(0, MAX_EVENT_STRING)}… [${value.length - MAX_EVENT_STRING} more characters]`
      : value;
  return redactSecretText(out);
}

/** An MCP server's address without what could carry a secret: only its origin is kept. */
function serverUrl(value: string): string {
  try {
    const url = new URL(value);
    const rest = url.pathname !== "/" || url.search || url.hash || url.username;
    return `${url.origin}${rest ? `/${REDACTED}` : ""}`;
  } catch {
    return REDACTED;
  }
}

/** Where the walk is: what the value is inside of. */
interface At {
  /** Inside a sign-in method: keep only the allowed keys' strings. */
  auth: boolean;
  /** Inside an MCP server's config. */
  mcp: boolean;
  /** Inside a value whose strings are all secrets (a credential key, a header or env map). */
  secret: boolean;
  /** Inside an item that touches a credentials file: only what names it is kept. */
  credentialFile: boolean;
}

/** The walk's budget and the objects it is inside of, to stop at a cycle. */
interface Walk {
  nodes: number;
  inside: Set<object>;
}

function walk(value: unknown, at: At, depth: number, state: Walk): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_EVENT_NODES) throw new UnstorablePayload("it holds too many values");
  if (typeof value === "string") {
    if (at.secret || at.auth) return REDACTED;
    if (at.credentialFile) return CREDENTIAL_FILE_REDACTED;
    return redactString(value);
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_JSON_DEPTH) throw new UnstorablePayload("it nests too deep");
  if (state.inside.has(value)) return "[circular]";
  state.inside.add(value);
  try {
    if (Array.isArray(value)) return value.map((inner) => walk(inner, at, depth + 1, state));
    const here =
      !at.credentialFile && touchesCredentialFile(value as Record<string, unknown>)
        ? { ...at, credentialFile: true }
        : at;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const name = normalizedKey(key);
      let next = here;
      if (here.auth && AUTH_KEPT_KEYS.has(key) && typeof inner === "string") {
        out[key] = inner;
        continue;
      }
      if (here.credentialFile && name === "command" && !here.secret && !here.auth) {
        out[key] = credentialCommand(inner);
        continue;
      }
      if (here.secret || isSecretKey(key) || (SECRET_MAPS.has(name) && isRecord(inner)))
        next = { ...here, secret: true };
      else if (here.credentialFile && KEPT_ON_CREDENTIAL_FILE.has(key))
        next = { ...here, credentialFile: false };
      if (!next.secret && name === "database64" && typeof inner === "string") {
        // File contents read or written through Codex: their size is kept, never the bytes.
        out[key] = `[${Math.floor((inner.length * 3) / 4)} bytes]`;
        continue;
      }
      if (!next.secret && here.mcp && name === "url" && typeof inner === "string") {
        out[key] = serverUrl(inner);
        continue;
      }
      // `mcp_servers`, or the dotted form a config override uses (`mcp_servers.github`).
      if (name.startsWith("mcpservers")) next = { ...next, mcp: true };
      out[key] = walk(inner, next, depth + 1, state);
    }
    return out;
  } finally {
    state.inside.delete(value);
  }
}

/**
 * A message's payload as it is stored: every credential redacted.
 * - By method, sign-in messages keep only their type and reason.
 * - By key, anything named like a token, key, secret, password, cookie or account id, and every
 *   value of an `env` or headers map (MCP servers' and providers'), is redacted, and MCP server
 *   URLs keep only their origin.
 * - In every string, credentials written as text are redacted (`redactSecretText`), and strings
 *   past `MAX_EVENT_STRING` are cut.
 * - An item, request or file change that runs or touches a known credentials file
 *   (`CREDENTIAL_FILE`) keeps only what it is and the files it touched, never its command text,
 *   output or content.
 * - File contents (`dataBase64`) are kept only as their size.
 * Throws `UnstorablePayload` for a payload nested deeper than `MAX_JSON_DEPTH` or holding more
 * than `MAX_EVENT_NODES` values; a cycle is stored as `[circular]`.
 */
export function redactCodexPayload(method: string, payload: unknown): unknown {
  return walk(
    payload,
    { auth: AUTH_METHODS.has(method), mcp: false, secret: false, credentialFile: false },
    0,
    { nodes: 0, inside: new Set() },
  );
}
