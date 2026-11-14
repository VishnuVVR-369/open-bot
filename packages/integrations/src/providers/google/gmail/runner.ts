// Runs approved Gmail changes for the executor, and finds out whether an interrupted one happened.
import { GmailApi, header, type GmailDraft, type GmailMessage } from "./api";
import type {
  ActionOutcome,
  ActionRow,
  ActionRunner,
  IntegrationHost,
} from "../../../core/adapter";
import { ACTION_HEADER } from "./writes";

/** Runs Gmail actions for the executor. */
export function gmailRunner(host: IntegrationHost): ActionRunner {
  return {
    execute: async (action, tokens) => {
      const api = new GmailApi(tokens, host.endpoints);
      const request = action.request as Record<string, unknown>;
      switch (action.tool) {
        case "gmail.create_draft": {
          const draft = await api.write<GmailDraft>("POST", "/drafts", {
            message: {
              raw: request.raw,
              ...(request.threadId ? { threadId: request.threadId } : {}),
            },
          });
          return {
            status: "done",
            message: `Drafted it (draft_id ${draft.id}). The user can open it in Gmail's Drafts. To send it, call gmail.send_draft with this draft_id.`,
            result: { draftId: draft.id, threadId: draft.message.threadId },
            providerRef: { draftId: draft.id },
          };
        }
        case "gmail.update_draft": {
          const draft = await api.write<GmailDraft>(
            "PUT",
            `/drafts/${encodeURIComponent(String(request.draftId))}`,
            {
              id: request.draftId,
              message: { raw: request.raw, threadId: request.threadId },
            },
          );
          return {
            status: "done",
            message: `Changed the draft (draft_id ${draft.id}).`,
            result: { draftId: draft.id },
          };
        }
        case "gmail.send_draft":
          return send(api, request);
        case "gmail.organize": {
          for (const threadId of request.threadIds as string[])
            await api.write("POST", `/threads/${encodeURIComponent(threadId)}/modify`, {
              addLabelIds: request.addLabelIds,
              removeLabelIds: request.removeLabelIds,
            });
          return { status: "done", message: "Done.", result: {} };
        }
        default:
          return { status: "failed", error: `Unknown Gmail action ${action.tool}.` };
      }
    },
    reconcile: async (action, tokens) => {
      const api = new GmailApi(tokens, host.endpoints);
      const request = action.request as Record<string, unknown>;
      switch (action.tool) {
        // Changing labels or a draft again leaves it the same, so running it again is safe.
        case "gmail.update_draft":
        case "gmail.organize":
          return "not_done";
        case "gmail.create_draft": {
          const found = await api.get<{ drafts?: { id: string }[] }>("/drafts", {
            q: `rfc822msgid:${String(request.messageId)}`,
          });
          const draft = found.drafts?.[0];
          return draft
            ? {
                status: "done",
                message: `Drafted it (draft_id ${draft.id}).`,
                result: { draftId: draft.id },
                providerRef: { draftId: draft.id },
              }
            : "not_done";
        }
        case "gmail.send_draft": {
          const sent = await findSent(api, action);
          return sent
            ? {
                status: "done",
                message: `Sent (message id ${sent.id}).`,
                result: { messageId: sent.id, threadId: sent.threadId },
              }
            : // Not in Sent yet doesn't prove it wasn't sent: never risk sending twice.
              null;
        }
        default:
          return null;
      }
    },
  };
}

/** Send the frozen message, then remove the draft it came from. */
async function send(api: GmailApi, request: Record<string, unknown>): Promise<ActionOutcome> {
  const message = await api.write<GmailMessage>("POST", "/messages/send", {
    raw: request.raw,
    ...(request.threadId ? { threadId: request.threadId } : {}),
  });
  // The draft would otherwise stay behind, and could be sent a second time.
  await api
    .write("DELETE", `/drafts/${encodeURIComponent(String(request.draftId))}`)
    .catch(() => {});
  return {
    status: "done",
    message: `Sent (message id ${message.id}).`,
    result: { messageId: message.id, threadId: message.threadId },
    providerRef: { messageId: message.id },
  };
}

/** The message this action sent, found in Sent by its marker header. */
async function findSent(api: GmailApi, action: ActionRow): Promise<GmailMessage | null> {
  // Narrowed to a recipient, so a busy Sent folder doesn't push it out of the first page.
  const preview = action.preview?.type === "email" ? action.preview : null;
  const recipient = [...(preview?.to ?? []), ...(preview?.cc ?? []), ...(preview?.bcc ?? [])]
    .map((entry) => /<([^>]+)>/.exec(entry)?.[1] ?? entry)
    .map((entry) => entry.trim())
    .find((entry) => /^[^\s"()]+@[^\s"()]+$/.test(entry));
  const list = await api.get<{ messages?: { id: string }[] }>("/messages", {
    q: `in:sent newer_than:2d${recipient ? ` to:${recipient}` : ""}`,
    maxResults: 30,
  });
  for (const entry of list.messages ?? []) {
    const message = await api.get<GmailMessage>(`/messages/${encodeURIComponent(entry.id)}`, {
      format: "metadata",
      metadataHeaders: [ACTION_HEADER],
    });
    if (header(message, ACTION_HEADER).trim() === action.id) return message;
  }
  return null;
}
