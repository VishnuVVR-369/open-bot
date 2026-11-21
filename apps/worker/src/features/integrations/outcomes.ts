// How an account action's state reads: what its teammate is told, the follow-up run's prompt,
// and its tool item in the timeline. `actions.ts` decides the state; this only describes it.
import {
  type AccountActionStatus,
  accountTool,
  FINISHED_ACTION_STATUSES,
  integration,
  type ToolItem,
} from "@open-bot/domain";
import type { ActionRow } from "@open-bot/integrations/adapters";

const FINISHED = new Set<string>(FINISHED_ACTION_STATUSES);
export const NEEDS_FOLLOW_UP = new Set<AccountActionStatus>([
  "denied",
  "failed",
  "unknown",
  "cancelled",
  "expired",
]);

export function isFinished(row: Pick<ActionRow, "status">): boolean {
  return FINISHED.has(row.status);
}

/** What the teammate is told for an action in this state. */
export function actionMessage(row: ActionRow): string {
  const info = accountTool(row.tool);
  const provider = info ? integration(info.kind).label : "the service";
  switch (row.status) {
    case "done":
      return typeof row.result?.message === "string" ? row.result.message : "Done.";
    case "failed":
      return `It failed: ${row.error ?? "the provider refused it."}`;
    case "unknown":
      return `It may or may not have happened: ${row.error ?? "the answer was lost."} Don't do it again; tell the user, so they can check ${provider}.`;
    case "denied":
      return "The user didn't approve it, so it wasn't done. Don't do it, and don't ask again unless they bring it up.";
    case "cancelled":
      return `It was cancelled: ${row.error ?? "the connection changed."}`;
    case "expired":
      return "It wasn't approved within 7 days, so it won't happen.";
    case "waiting_on_provider":
      return `${provider} is still working on it, and it finishes by itself. Check the result later before relying on it.`;
    default:
      return "It's waiting for the user's approval, and happens by itself the moment they approve. Don't ask again or repeat it. End your turn and say it's ready for their approval.";
  }
}

/** The follow-up run's prompt when an action ends after its teammate stopped waiting. */
export function followUp(row: ActionRow): string {
  switch (row.status) {
    case "denied":
      return `[Not approved] The user didn't approve: ${row.summary}. It wasn't done. Don't do it. Briefly acknowledge, and continue with anything else that's left.`;
    case "failed":
      return `[Couldn't do it] ${row.summary} failed after the user approved it: ${row.error}. Tell the user briefly, and fix it if you can.`;
    case "unknown":
      return `[Unclear] ${row.summary} may or may not have happened: ${row.error}. Don't do it again. Tell the user, so they can check.`;
    case "cancelled":
      return `[Cancelled] ${row.summary} didn't happen: ${row.error}. Tell the user only if it still matters.`;
    default:
      return `[Expired] The user didn't approve ${row.summary} within 7 days, so it won't happen. Mention it only if it still matters.`;
  }
}

/** The action's tool item in the timeline, as it stands. */
export function actionItem(
  row: Pick<ActionRow, "itemId" | "tool" | "summary" | "labels" | "preview"> &
    Partial<Pick<ActionRow, "error" | "result">>,
  status: AccountActionStatus,
  startedAt: string,
): ToolItem {
  const finished = FINISHED.has(status);
  const label =
    status === "done"
      ? row.labels.done
      : status === "pending"
        ? row.labels.waiting
        : status === "denied"
          ? `Not approved: ${row.summary}`
          : status === "unknown"
            ? `${row.summary}: may or may not have happened`
            : status === "cancelled" || status === "expired"
              ? `Didn't happen: ${row.summary}`
              : finished
                ? row.labels.failed
                : row.summary;
  return {
    id: row.itemId,
    kind: "tool",
    name: row.tool,
    label: label.slice(0, 160),
    args: row.preview ?? { summary: row.summary },
    status: !finished ? "running" : status === "done" ? "completed" : "failed",
    startedAt,
    ...(finished ? { completedAt: new Date().toISOString() } : {}),
    ...(status === "done" && typeof row.result?.message === "string"
      ? { result: row.result.message }
      : {}),
    ...(finished && status !== "done" ? { error: row.error ?? label } : {}),
  };
}
