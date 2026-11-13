import { randomBytes } from "node:crypto";
import { b64url, empty, type Exchange, id16, json, jsonBody } from "./http";
import {
  composeRaw,
  headerOf,
  type MimePart,
  parseMime,
  plainText,
  type SeedMessage,
} from "./mime";
import { googleAuth, googleError, GoogleStandIn, SCOPES } from "./google";

// ---------------------------------------------------------------------------------------------
// Gmail

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  raw: string;
  mime: MimePart;
  internalDate: number;
  /** Attachment ids handed out so far: Gmail gives new ones on each read. */
  attachments: Map<string, Buffer>;
}

export interface SentMessage {
  id: string;
  threadId: string;
  raw: string;
  at: number;
}

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
  "CATEGORY_PERSONAL",
  "CATEGORY_UPDATES",
];

const GMAIL_READ = [SCOPES.gmailRead, SCOPES.gmailModify] as const;

const GMAIL_DRAFTS_READ = [SCOPES.gmailRead, SCOPES.gmailCompose, SCOPES.gmailModify] as const;

const GMAIL_COMPOSE = [SCOPES.gmailCompose, SCOPES.gmailModify] as const;

const GMAIL_MODIFY = [SCOPES.gmailModify] as const;

/** One Gmail mailbox, the signed-in user's, with Gmail's REST API over it. */
export class GmailStandIn {
  readonly messages = new Map<string, StoredMessage>();
  /** Draft id to message id. */
  readonly drafts = new Map<string, string>();
  readonly labels = new Map<string, { id: string; name: string; type: "system" | "user" }>();
  /** What was sent, exactly as it was sent. */
  readonly sent: SentMessage[] = [];

  constructor(
    private readonly google: GoogleStandIn,
    private readonly owner: () => string,
  ) {
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
    this.labels.set("Label_1", { id: "Label_1", name: "Receipts", type: "user" });
    this.labels.set("Label_2", { id: "Label_2", name: "Follow up", type: "user" });
  }

  /** A message arrives (or is already there). */
  deliver(seed: SeedMessage): { id: string; threadId: string; messageId: string } {
    const { raw, messageId } = composeRaw(seed, this.owner());
    const message = this.store(raw, seed.threadId ?? null, seed.labels ?? ["INBOX", "UNREAD"], {
      internalDate: (seed.date ?? new Date()).getTime(),
    });
    return { id: message.id, threadId: message.threadId, messageId };
  }

  /** The message a draft holds now, as text. */
  draftRaw(draftId: string): string | null {
    const messageId = this.drafts.get(draftId);
    return messageId ? (this.messages.get(messageId)?.raw ?? null) : null;
  }

  /** The user edits a draft in Gmail: a new message replaces the draft's. */
  editDraft(draftId: string, text: string) {
    const messageId = this.drafts.get(draftId);
    const current = messageId ? this.messages.get(messageId) : undefined;
    if (!current) throw new Error(`No draft ${draftId}`);
    const header = (name: string) => headerOf(current.mime, name);
    const { raw } = composeRaw(
      {
        from: header("From"),
        to: header("To")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        subject: header("Subject"),
        text,
        ...(header("In-Reply-To") ? { inReplyTo: header("In-Reply-To") } : {}),
        labels: ["DRAFT"],
      },
      this.owner(),
    );
    this.messages.delete(current.id);
    const next = this.store(raw, current.threadId, ["DRAFT"]);
    this.drafts.set(draftId, next.id);
  }

  /** Each message in a thread, oldest first. */
  thread(threadId: string): StoredMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.internalDate - b.internalDate);
  }

  private store(
    raw: string,
    threadId: string | null,
    labels: string[],
    options: { internalDate?: number } = {},
  ): StoredMessage {
    const id = id16();
    const thread = threadId && this.thread(threadId).length ? threadId : id;
    const message: StoredMessage = {
      id,
      threadId: thread,
      labelIds: new Set(labels),
      raw,
      mime: parseMime(raw),
      internalDate: options.internalDate ?? Date.now(),
      attachments: new Map(),
    };
    this.messages.set(id, message);
    return message;
  }

  handle(ex: Exchange): boolean {
    const prefix = "/gmail/v1/users/me";
    if (!ex.url.pathname.startsWith(`${prefix}/`)) return false;
    const segments = ex.url.pathname
      .slice(prefix.length + 1)
      .split("/")
      .map(decodeURIComponent);
    const [collection, id, sub, subId] = segments;
    const route =
      collection === "messages" && id === "send" && !sub
        ? `${ex.method} messages/send`
        : `${ex.method} ${collection}${id ? "/:id" : ""}${sub ? `/${sub}` : ""}${subId ? "/:sub" : ""}`;
    const need = (scopes: readonly string[]) => googleAuth(this.google, ex, scopes) !== null;
    switch (route) {
      case "GET profile":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        json(ex, 200, {
          emailAddress: this.owner(),
          messagesTotal: this.messages.size,
          threadsTotal: new Set([...this.messages.values()].map((message) => message.threadId))
            .size,
          historyId: "1000",
        });
        return true;
      case "GET labels":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        json(ex, 200, {
          labels: [...this.labels.values()].map((label) => ({
            ...label,
            ...(label.type === "user"
              ? { labelListVisibility: "labelShow", messageListVisibility: "show" }
              : {}),
          })),
        });
        return true;
      case "GET threads":
        if (!need(GMAIL_READ)) return true;
        this.listThreads(ex);
        return true;
      case "GET threads/:id":
        if (!need(GMAIL_READ)) return true;
        this.getThread(ex, id!);
        return true;
      case "POST threads/:id/modify":
        if (!need(GMAIL_MODIFY)) return true;
        this.modify(ex, id!);
        return true;
      case "GET messages":
        if (!need(GMAIL_READ)) return true;
        this.listMessages(ex);
        return true;
      case "GET messages/:id":
        if (!need(GMAIL_READ)) return true;
        this.getMessage(ex, id!);
        return true;
      case "GET messages/:id/attachments/:sub":
        if (!need(GMAIL_READ)) return true;
        this.getAttachment(ex, id!, subId!);
        return true;
      case "POST messages/send":
        if (!need(GMAIL_COMPOSE)) return true;
        this.sendMessage(ex);
        return true;
      case "GET drafts":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        this.listDrafts(ex);
        return true;
      case "POST drafts":
        if (!need(GMAIL_COMPOSE)) return true;
        this.createDraft(ex);
        return true;
      case "GET drafts/:id":
        if (!need([...GMAIL_DRAFTS_READ])) return true;
        this.getDraft(ex, id!);
        return true;
      case "PUT drafts/:id":
        if (!need(GMAIL_COMPOSE)) return true;
        this.updateDraft(ex, id!);
        return true;
      case "DELETE drafts/:id":
        if (!need(GMAIL_COMPOSE)) return true;
        this.deleteDraft(ex, id!);
        return true;
      default:
        googleError(ex, 404, `Not found: ${ex.method} ${ex.url.pathname}`);
        return true;
    }
  }

  private resource(message: StoredMessage, format: string, metadataHeaders: string[]) {
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      snippet: plainText(message.mime).replace(/\s+/g, " ").trim().slice(0, 160),
      historyId: "1000",
      internalDate: String(message.internalDate),
      sizeEstimate: Buffer.byteLength(message.raw),
    };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: b64url(message.raw) };
    if (format === "metadata") {
      const wanted = new Set(metadataHeaders.map((name) => name.toLowerCase()));
      return {
        ...base,
        payload: {
          mimeType: message.mime.mimeType,
          headers: message.mime.headers.filter(
            (entry) => wanted.size === 0 || wanted.has(entry.name.toLowerCase()),
          ),
        },
      };
    }
    const part = (mime: MimePart, partId: string): Record<string, unknown> => {
      const attachment = Boolean(mime.filename) && mime.parts.length === 0;
      let body: Record<string, unknown> = { size: mime.content.length };
      if (attachment) {
        const attachmentId = `ANGjdJ_${randomBytes(24).toString("base64url")}`;
        message.attachments.set(attachmentId, mime.content);
        body = { attachmentId, size: mime.content.length };
      } else if (mime.parts.length === 0) body.data = b64url(mime.content);
      return {
        partId,
        mimeType: mime.mimeType,
        filename: mime.filename,
        headers: mime.headers,
        body,
        ...(mime.parts.length
          ? {
              parts: mime.parts.map((child, index) =>
                part(child, partId ? `${partId}.${index}` : String(index)),
              ),
            }
          : {}),
      };
    };
    return { ...base, payload: part(message.mime, "") };
  }

  private format(ex: Exchange, fallback = "full") {
    return {
      format: ex.url.searchParams.get("format") ?? fallback,
      headers: ex.url.searchParams.getAll("metadataHeaders"),
    };
  }

  /** Gmail's search syntax, as far as teammates use it. */
  private matcher(q: string): (message: StoredMessage) => boolean {
    const terms: { negate: boolean; op: string; value: string }[] = [];
    for (const match of q.matchAll(/(-)?(?:([a-z][a-z0-9_]*):)?("[^"]*"|\S+)/gi)) {
      const value = (match[3] ?? "").replace(/^"(.*)"$/, "$1").toLowerCase();
      if (!match[2] && (value === "or" || value === "and")) continue;
      terms.push({ negate: Boolean(match[1]), op: (match[2] ?? "").toLowerCase(), value });
    }
    const placed = terms.some(
      (term) =>
        (term.op === "in" && ["spam", "trash", "anywhere"].includes(term.value)) ||
        (term.op === "is" && ["spam", "trash"].includes(term.value)),
    );
    const age = (value: string) => {
      const found = /^(\d+)([hdmy])$/.exec(value);
      if (!found) return 0;
      const unit = { h: 3600e3, d: 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[
        found[2] as "h" | "d" | "m" | "y"
      ];
      return Number(found[1]) * unit;
    };
    const day = (value: string) =>
      /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value.replace(/\//g, "-"));
    const labelIs = (message: StoredMessage, name: string) => {
      const wanted = name.replace(/[-/]/g, " ");
      return [...message.labelIds].some((id) => {
        const label = this.labels.get(id);
        return (
          id.toLowerCase() === name ||
          (label?.name.toLowerCase().replace(/[-/]/g, " ") ?? "") === wanted
        );
      });
    };
    return (message) => {
      if (!placed && (message.labelIds.has("SPAM") || message.labelIds.has("TRASH"))) return false;
      const header = (name: string) => headerOf(message.mime, name).toLowerCase();
      const recipients = `${header("To")} ${header("Cc")} ${header("Bcc")}`;
      return terms.every((term) => {
        const { op, value } = term;
        let hit: boolean;
        switch (op) {
          case "from":
            hit = header("From").includes(value);
            break;
          case "to":
            hit = recipients.includes(value);
            break;
          case "cc":
            hit = header("Cc").includes(value);
            break;
          case "subject":
            hit = header("Subject").includes(value);
            break;
          case "in":
          case "is":
            hit =
              value === "anywhere"
                ? true
                : value === "read"
                  ? !message.labelIds.has("UNREAD")
                  : message.labelIds.has(value === "drafts" ? "DRAFT" : value.toUpperCase());
            break;
          case "label":
            hit = labelIs(message, value);
            break;
          case "has":
            hit = value === "attachment" && /\bfilename=/i.test(message.raw);
            break;
          case "filename":
            hit = message.raw.toLowerCase().includes(`filename="${value}`);
            break;
          case "newer_than":
            hit = message.internalDate >= Date.now() - age(value);
            break;
          case "older_than":
            hit = message.internalDate < Date.now() - age(value);
            break;
          case "after":
            hit = message.internalDate >= day(value);
            break;
          case "before":
            hit = message.internalDate < day(value);
            break;
          case "rfc822msgid":
            hit = header("Message-ID").replace(/[<>]/g, "") === value.replace(/[<>]/g, "");
            break;
          default:
            hit = `${header("From")} ${recipients} ${header("Subject")} ${plainText(message.mime)}`
              .toLowerCase()
              .includes(value);
        }
        return term.negate ? !hit : hit;
      });
    };
  }

  private limit(ex: Exchange, fallback = 100) {
    const value = Number(ex.url.searchParams.get("maxResults") ?? fallback);
    return Math.min(Math.max(Number.isFinite(value) ? value : fallback, 1), 500);
  }

  private listThreads(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const threads = new Map<string, StoredMessage[]>();
    for (const message of this.messages.values()) {
      const list = threads.get(message.threadId) ?? [];
      list.push(message);
      threads.set(message.threadId, list);
    }
    const found = [...threads.entries()]
      .filter(([, messages]) => messages.some(matches))
      .map(([id, messages]) => ({ id, latest: Math.max(...messages.map((m) => m.internalDate)) }))
      .sort((a, b) => b.latest - a.latest);
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? {
            threads: shown.map(({ id }) => ({
              id,
              snippet: this.resource(this.thread(id).at(-1)!, "minimal", []).snippet,
              historyId: "1000",
            })),
          }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private getThread(ex: Exchange, threadId: string) {
    const messages = this.thread(threadId);
    if (!messages.length) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, {
      id: threadId,
      historyId: "1000",
      messages: messages.map((message) => this.resource(message, format, headers)),
    });
  }

  private modify(ex: Exchange, threadId: string) {
    const messages = this.thread(threadId);
    if (!messages.length) return googleError(ex, 404, "Requested entity was not found.");
    const body = jsonBody(ex);
    const add = (body.addLabelIds as string[] | undefined) ?? [];
    const remove = (body.removeLabelIds as string[] | undefined) ?? [];
    const unknown = [...add, ...remove].find((label) => !this.labels.has(label));
    if (unknown) return googleError(ex, 400, `Invalid label: ${unknown}`, "invalidArgument");
    for (const message of messages) {
      for (const label of add) message.labelIds.add(label);
      for (const label of remove) message.labelIds.delete(label);
    }
    json(ex, 200, {
      id: threadId,
      messages: messages.map((message) => this.resource(message, "minimal", [])),
    });
  }

  private listMessages(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const found = [...this.messages.values()]
      .filter(matches)
      .sort((a, b) => b.internalDate - a.internalDate);
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? { messages: shown.map((message) => ({ id: message.id, threadId: message.threadId })) }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private getMessage(ex: Exchange, id: string) {
    const message = this.messages.get(id);
    if (!message) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, this.resource(message, format, headers));
  }

  private getAttachment(ex: Exchange, messageId: string, attachmentId: string) {
    const data = this.messages.get(messageId)?.attachments.get(attachmentId);
    if (!data) return googleError(ex, 400, "Invalid attachment token", "invalidArgument");
    json(ex, 200, { attachmentId, size: data.length, data: b64url(data) });
  }

  /** The raw message of a request body, or an answer saying why it can't be one. */
  private rawOf(ex: Exchange, value: unknown): string | null {
    if (typeof value !== "string" || !value) {
      googleError(ex, 400, "Invalid value for ByteString: ", "invalidArgument");
      return null;
    }
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const mime = parseMime(raw);
    if (!headerOf(mime, "To") && !headerOf(mime, "Cc") && !headerOf(mime, "Bcc")) {
      googleError(ex, 400, "Recipient address required", "invalidArgument");
      return null;
    }
    return raw;
  }

  private threadOf(value: unknown): string | null {
    return typeof value === "string" && this.thread(value).length ? value : null;
  }

  private sendMessage(ex: Exchange) {
    const body = jsonBody(ex);
    const raw = this.rawOf(ex, body.raw);
    if (raw === null) return;
    const message = this.store(raw, this.threadOf(body.threadId), ["SENT"]);
    this.sent.push({ id: message.id, threadId: message.threadId, raw, at: Date.now() });
    json(ex, 200, { id: message.id, threadId: message.threadId, labelIds: ["SENT"] });
  }

  private draftResource(draftId: string, format: string, headers: string[] = []) {
    const message = this.messages.get(this.drafts.get(draftId)!)!;
    return { id: draftId, message: this.resource(message, format, headers) };
  }

  private listDrafts(ex: Exchange) {
    const matches = this.matcher(ex.url.searchParams.get("q") ?? "");
    const found = [...this.drafts.entries()].filter(([, messageId]) => {
      const message = this.messages.get(messageId);
      return message ? matches(message) : false;
    });
    const shown = found.slice(0, this.limit(ex));
    json(ex, 200, {
      ...(shown.length
        ? {
            drafts: shown.map(([id, messageId]) => ({
              id,
              message: { id: messageId, threadId: this.messages.get(messageId)!.threadId },
            })),
          }
        : {}),
      resultSizeEstimate: found.length,
    });
  }

  private createDraft(ex: Exchange) {
    const message = jsonBody(ex).message as Record<string, unknown> | undefined;
    const raw = typeof message?.raw === "string" ? Buffer.from(message.raw, "base64url") : null;
    if (!raw) return googleError(ex, 400, "Missing draft message", "invalidArgument");
    const stored = this.store(raw.toString("utf8"), this.threadOf(message?.threadId), ["DRAFT"]);
    const draftId = `r-${randomBytes(9).toString("hex")}`;
    this.drafts.set(draftId, stored.id);
    json(ex, 200, this.draftResource(draftId, "minimal"));
  }

  private getDraft(ex: Exchange, draftId: string) {
    if (!this.drafts.has(draftId)) return googleError(ex, 404, "Requested entity was not found.");
    const { format, headers } = this.format(ex);
    json(ex, 200, this.draftResource(draftId, format, headers));
  }

  private deleteDraft(ex: Exchange, draftId: string) {
    const messageId = this.drafts.get(draftId);
    if (!messageId) return googleError(ex, 404, "Requested entity was not found.");
    this.messages.delete(messageId);
    this.drafts.delete(draftId);
    empty(ex);
  }

  private updateDraft(ex: Exchange, draftId: string) {
    const current = this.drafts.get(draftId);
    if (!current) return googleError(ex, 404, "Requested entity was not found.");
    const message = jsonBody(ex).message as Record<string, unknown> | undefined;
    if (typeof message?.raw !== "string")
      return googleError(ex, 400, "Missing draft message", "invalidArgument");
    const threadId = this.messages.get(current)!.threadId;
    this.messages.delete(current);
    const stored = this.store(
      Buffer.from(message.raw, "base64url").toString("utf8"),
      this.threadOf(message.threadId) ?? threadId,
      ["DRAFT"],
    );
    this.drafts.set(draftId, stored.id);
    json(ex, 200, this.draftResource(draftId, "minimal"));
  }
}
