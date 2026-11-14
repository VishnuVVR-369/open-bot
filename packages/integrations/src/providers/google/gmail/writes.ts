// Gmail's change tools: each works out a change, frozen for approval, that the runner sends.
import { type AccountActionPreview } from "@open-bot/domain";
import { z } from "zod";
import { AccountToolError } from "../../../core/errors";
import { GmailApi, header, type GmailDraft, type GmailMessage } from "./api";
import {
  buildMime,
  ensureMessageId,
  fromBase64Url,
  newMessageId,
  parseHeaders,
  rawBody,
  splitAddresses,
  toBase64Url,
} from "./mime";
import type { PreparedAction, ToolContext } from "../../../core/adapter";
import { schemas } from "./tools";

/** The header that marks what open-bot sent, so a lost answer can be checked in Sent. */
export const ACTION_HEADER = "X-Open-Bot-Action";

/** Recipients, subject and body of a raw message, for the approval card. */
function emailPreview(raw: string, account: string, inReplyTo?: string): AccountActionPreview {
  const headers = parseHeaders(raw);
  const list = (name: string) =>
    (headers.get(name) ?? []).flatMap((value) => splitAddresses(value));
  return {
    type: "email",
    account,
    to: list("to"),
    cc: list("cc"),
    bcc: list("bcc"),
    subject: headers.get("subject")?.[0] ?? "",
    body: rawBody(raw),
    ...(inReplyTo ? { inReplyTo } : {}),
  };
}

function recipientsLine(preview: Extract<AccountActionPreview, { type: "email" }>): string {
  const all = [...preview.to, ...preview.cc, ...preview.bcc];
  return all.length <= 2 ? all.join(" and ") : `${all[0]} and ${all.length - 1} others`;
}

function domainOf(email: string): string {
  return email.split("@")[1] ?? "open-bot.local";
}

export async function createDraft(
  api: GmailApi,
  tc: ToolContext,
  args: z.infer<typeof schemas.create_draft>,
): Promise<PreparedAction> {
  const from = tc.resolved.account.display;
  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  let subject = args.subject;
  let replySubject: string | undefined;
  if (args.reply_to_message_id) {
    const original = await api.get<GmailMessage>(
      `/messages/${encodeURIComponent(args.reply_to_message_id)}`,
      {
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "Subject"],
      },
    );
    threadId = original.threadId;
    inReplyTo = header(original, "Message-ID") || null;
    references = header(original, "References") || null;
    replySubject = header(original, "Subject");
    subject ??= /^re:/i.test(replySubject) ? replySubject : `Re: ${replySubject}`;
  }
  if (!subject) throw new AccountToolError("Give the draft a subject.");
  const messageId = newMessageId(domainOf(from));
  const raw = buildMime({
    from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject,
    body: args.body,
    inReplyTo,
    references,
    messageId,
  });
  const preview = emailPreview(raw, from, replySubject) as Extract<
    AccountActionPreview,
    { type: "email" }
  >;
  return {
    tool: "gmail.create_draft",
    effect: "private_write",
    request: { raw: toBase64Url(raw), threadId, messageId },
    summary: `Draft “${subject}” to ${recipientsLine(preview)}`,
    detail: `To: ${args.to.join(", ")}\nSubject: ${subject}\n\n${args.body}`,
    preview,
    labels: {
      waiting: `Draft to ${recipientsLine(preview)} waits for you`,
      done: `Drafted “${subject}”`,
      failed: "Couldn't write a draft",
    },
  };
}

export async function updateDraft(
  api: GmailApi,
  tc: ToolContext,
  args: z.infer<typeof schemas.update_draft>,
): Promise<PreparedAction> {
  const draft = await api.get<GmailDraft>(`/drafts/${encodeURIComponent(args.draft_id)}`, {
    format: "raw",
  });
  const current = draft.message.raw ? fromBase64Url(draft.message.raw).toString("utf8") : "";
  const headers = parseHeaders(current);
  const list = (name: string) =>
    (headers.get(name) ?? []).flatMap((value) => splitAddresses(value));
  const from = tc.resolved.account.display;
  const subject = args.subject ?? headers.get("subject")?.[0] ?? "";
  const to = args.to ?? list("to");
  if (to.length === 0) throw new AccountToolError("The draft needs at least one recipient.");
  const raw = buildMime({
    from,
    to,
    cc: args.cc ?? list("cc"),
    bcc: args.bcc ?? list("bcc"),
    subject,
    body: args.body ?? rawBody(current),
    inReplyTo: headers.get("in-reply-to")?.[0] ?? null,
    references:
      headers
        .get("references")?.[0]
        ?.replace(headers.get("in-reply-to")?.[0] ?? "\0", "")
        .trim() || null,
    messageId: newMessageId(domainOf(from)),
  });
  const preview = emailPreview(raw, from) as Extract<AccountActionPreview, { type: "email" }>;
  return {
    tool: "gmail.update_draft",
    effect: "private_write",
    request: { draftId: draft.id, raw: toBase64Url(raw), threadId: draft.message.threadId },
    summary: `Change the draft “${subject}”`,
    detail: `To: ${to.join(", ")}\nSubject: ${subject}\n\n${preview.body}`,
    preview,
    labels: {
      waiting: `Change to the draft “${subject}” waits for you`,
      done: `Changed the draft “${subject}”`,
      failed: "Couldn't change a draft",
    },
  };
}

export async function sendDraft(
  api: GmailApi,
  tc: ToolContext,
  args: z.infer<typeof schemas.send_draft>,
): Promise<PreparedAction> {
  const draft = await api.get<GmailDraft>(`/drafts/${encodeURIComponent(args.draft_id)}`, {
    format: "raw",
  });
  if (!draft.message.raw) throw new AccountToolError("That draft is empty.");
  // Frozen now: what you approve is what goes out, whatever happens to the draft meanwhile.
  const original = fromBase64Url(draft.message.raw).toString("utf8");
  const marked = `${ACTION_HEADER}: ${tc.actionId}\r\n${original.replace(new RegExp(`^${ACTION_HEADER}:.*\\r?\\n`, "im"), "")}`;
  const { raw, messageId } = ensureMessageId(
    marked,
    newMessageId(domainOf(tc.resolved.account.display)),
  );
  const preview = emailPreview(raw, tc.resolved.account.display) as Extract<
    AccountActionPreview,
    { type: "email" }
  >;
  if (preview.to.length + preview.cc.length + preview.bcc.length === 0)
    throw new AccountToolError(
      "The draft has no recipients. Add them with gmail.update_draft first.",
    );
  const subject = preview.subject || "(no subject)";
  return {
    tool: "gmail.send_draft",
    effect: "outward",
    request: {
      draftId: draft.id,
      threadId: draft.message.threadId,
      raw: toBase64Url(raw),
      messageId,
    },
    summary: `Send “${subject}” to ${recipientsLine(preview)}`,
    detail: [
      `To: ${preview.to.join(", ")}`,
      ...(preview.cc.length ? [`Cc: ${preview.cc.join(", ")}`] : []),
      ...(preview.bcc.length ? [`Bcc: ${preview.bcc.join(", ")}`] : []),
      `Subject: ${subject}`,
      "",
      preview.body,
    ].join("\n"),
    preview,
    labels: {
      waiting: `Email to ${recipientsLine(preview)} waits for you`,
      done: `Sent “${subject}” to ${recipientsLine(preview)}`,
      failed: `Couldn't send “${subject}”`,
    },
  };
}

export async function organize(
  api: GmailApi,
  args: z.infer<typeof schemas.organize>,
): Promise<PreparedAction> {
  const { labels = [] } = await api.get<{ labels?: { id: string; name: string }[] }>("/labels");
  const byName = new Map(
    labels.flatMap((label) => [
      [label.name.toLowerCase(), label.id],
      [label.id.toLowerCase(), label.id],
    ]),
  );
  const resolve = (names: string[]) =>
    names.map((name) => {
      const id = byName.get(name.toLowerCase());
      if (!id) throw new AccountToolError(`Gmail has no label "${name}". See gmail.list_labels.`);
      return id;
    });
  const add = new Set(resolve(args.add_labels));
  const remove = new Set(resolve(args.remove_labels));
  if (args.archive) remove.add("INBOX");
  if (args.mark_read === true) remove.add("UNREAD");
  if (args.mark_read === false) add.add("UNREAD");
  if (add.size === 0 && remove.size === 0)
    throw new AccountToolError("Say what to change: labels, archive or mark_read.");
  const what = [
    ...(args.archive ? ["archive"] : []),
    ...(args.mark_read === true ? ["mark read"] : args.mark_read === false ? ["mark unread"] : []),
    ...(args.add_labels.length ? [`label ${args.add_labels.join(", ")}`] : []),
    ...(args.remove_labels.length ? [`unlabel ${args.remove_labels.join(", ")}`] : []),
  ].join(", ");
  const count = `${args.thread_ids.length} thread${args.thread_ids.length === 1 ? "" : "s"}`;
  return {
    tool: "gmail.organize",
    effect: "private_write",
    request: { threadIds: args.thread_ids, addLabelIds: [...add], removeLabelIds: [...remove] },
    summary: `${what[0]!.toUpperCase()}${what.slice(1)} ${count} in Gmail`,
    detail: `${what}: ${args.thread_ids.join(", ")}`,
    preview: null,
    labels: {
      waiting: `Organizing ${count} waits for you`,
      done: `Organized ${count} in Gmail (${what})`,
      failed: "Couldn't organize Gmail",
    },
  };
}
