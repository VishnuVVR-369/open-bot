// Gmail's tools: the arguments each one takes (zod) and how it is described to Codex.
import { z } from "zod";
import { emails, tool, type NamespaceTool } from "../../../core/tool-spec";

const address = z.string().trim().email("That isn't an email address.");
const addressList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : value,
  z.array(address).max(50, "50 addresses at most."),
);
const accountArg = z.string().optional();

export const schemas = {
  search: z.object({
    query: z.string().trim().max(500).default(""),
    max_results: z.number().int().min(1).max(50).default(20),
    account: accountArg,
  }),
  read_thread: z.object({ thread_id: z.string().trim().min(1), account: accountArg }),
  get_attachment: z.object({
    message_id: z.string().trim().min(1),
    part_id: z.string().trim().min(1),
    account: accountArg,
  }),
  list_labels: z.object({ account: accountArg }),
  create_draft: z.object({
    to: addressList.pipe(z.array(address).min(1, "Add at least one recipient.")),
    cc: addressList.default([]),
    bcc: addressList.default([]),
    subject: z.string().trim().max(500).optional(),
    body: z.string().max(100_000),
    reply_to_message_id: z.string().trim().min(1).optional(),
    account: accountArg,
  }),
  update_draft: z.object({
    draft_id: z.string().trim().min(1),
    to: addressList.optional(),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    subject: z.string().trim().max(500).optional(),
    body: z.string().max(100_000).optional(),
    account: accountArg,
  }),
  send_draft: z.object({ draft_id: z.string().trim().min(1), account: accountArg }),
  organize: z.object({
    thread_ids: z.array(z.string().trim().min(1)).min(1).max(100),
    add_labels: z.array(z.string().trim().min(1)).max(20).default([]),
    remove_labels: z.array(z.string().trim().min(1)).max(20).default([]),
    archive: z.boolean().optional(),
    mark_read: z.boolean().optional(),
    account: accountArg,
  }),
};

export const GMAIL_TOOLS: NamespaceTool[] = [
  tool(
    "search",
    "Search the user's Gmail with Gmail's search syntax, like `from:sam is:unread newer_than:7d` or `subject:invoice has:attachment`. Returns up to 50 threads, newest first, with their ids, senders, subjects and snippets. An empty query lists the latest threads.",
    {
      query: { type: "string", description: "Gmail search syntax." },
      max_results: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
    },
  ),
  tool(
    "read_thread",
    "Read a Gmail thread: every message's headers and text, oldest first, with attachments listed by part_id.",
    { thread_id: { type: "string" } },
    ["thread_id"],
  ),
  tool(
    "get_attachment",
    "Save an attachment from a message into your workspace (attachments/), and get its path. Up to 25 MB.",
    {
      message_id: { type: "string" },
      part_id: { type: "string", description: "From read_thread's attachment list." },
    },
    ["message_id", "part_id"],
  ),
  tool("list_labels", "List the user's Gmail labels, with their ids.", {}),
  tool(
    "create_draft",
    "Write a draft in the user's Gmail, as them. Plain text. To reply, pass reply_to_message_id (a message id from read_thread): the draft joins that thread, and the subject defaults to Re: theirs. The user sees it in Gmail's Drafts. Sending is a separate step, send_draft.",
    {
      to: emails("Recipients."),
      cc: emails("Cc recipients."),
      bcc: emails("Bcc recipients."),
      subject: { type: "string", description: "Required unless replying." },
      body: { type: "string", description: "Plain text." },
      reply_to_message_id: { type: "string" },
    },
    ["to", "body"],
  ),
  tool(
    "update_draft",
    "Change a draft: give only what changes. Recipients and body replace the old ones.",
    {
      draft_id: { type: "string" },
      to: emails("Recipients."),
      cc: emails("Cc recipients."),
      bcc: emails("Bcc recipients."),
      subject: { type: "string" },
      body: { type: "string", description: "Plain text." },
    },
    ["draft_id"],
  ),
  tool(
    "send_draft",
    "Send a draft from the user's Gmail. It asks the user first (they see exactly what goes out), and sends by itself once they approve; don't call it twice. Later changes to the draft don't change what's sent.",
    { draft_id: { type: "string" } },
    ["draft_id"],
  ),
  tool(
    "organize",
    "Label, archive, or mark threads read or unread. Labels by name or id (see list_labels).",
    {
      thread_ids: { type: "array", items: { type: "string" }, minItems: 1 },
      add_labels: { type: "array", items: { type: "string" } },
      remove_labels: { type: "array", items: { type: "string" } },
      archive: { type: "boolean", description: "Take them out of the inbox." },
      mark_read: { type: "boolean", description: "true marks read; false marks unread." },
    },
    ["thread_ids"],
  ),
];
