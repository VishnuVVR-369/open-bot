import "server-only";
import type { ApprovalView, MessageView } from "@open-bot/api";
import type { approvals, messages } from "@open-bot/db";
import type { AccountActionPreview } from "@open-bot/shared";

/** Database rows as the API and the UI read them. */

export function toMessageView(row: typeof messages.$inferSelect): MessageView {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    attachments: row.attachments,
    mentions: row.mentions,
    steeredRunId: row.steeredRunId,
    redoOfRunId: row.redoOfRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toApprovalView(row: typeof approvals.$inferSelect): ApprovalView {
  return {
    id: row.id,
    runId: row.runId,
    botId: row.botId,
    chatId: row.chatId,
    kind: row.kind,
    subject: typeof row.payload.subject === "string" ? row.payload.subject : null,
    askEveryTime: row.payload.askEveryTime === true,
    title: row.title,
    detail: row.detail,
    preview: (row.payload.preview as AccountActionPreview | undefined) ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
