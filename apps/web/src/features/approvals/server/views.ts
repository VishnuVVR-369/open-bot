import "server-only";
import type { ApprovalView } from "@open-bot/api";
import type { approvals } from "@open-bot/db";
import type { AccountActionPreview } from "@open-bot/domain";

/** Database rows as the API and the UI read them. */

export function toApprovalView(row: typeof approvals.$inferSelect): ApprovalView {
  return {
    id: row.id,
    runId: row.runId,
    teammateId: row.teammateId,
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
