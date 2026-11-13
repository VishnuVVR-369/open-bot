/**
 * Notifications that repeat back to back (the same kind, teammate, title and text) shown as one
 * row with a count, so a reminder sent twice doesn't take up the screen twice.
 */
export function collapseRepeats<
  T extends { id: string; kind: string; title: string; body: string; botId: string | null },
>(notifications: T[]): { key: string; items: T[] }[] {
  const rows: { key: string; items: T[] }[] = [];
  for (const notification of notifications) {
    const last = rows.at(-1)?.items[0];
    if (
      last &&
      last.kind === notification.kind &&
      last.botId === notification.botId &&
      last.title === notification.title &&
      last.body === notification.body
    )
      rows.at(-1)!.items.push(notification);
    else rows.push({ key: notification.id, items: [notification] });
  }
  return rows;
}

/**
 * A notification's words as the row shows them. A failure titled "Kit couldn't finish: <task>"
 * reads as if the task were what failed to happen ("couldn't finish: GitHub release published"),
 * so the task's name is quoted: "Kit couldn't finish “GitHub release published”".
 */
export function notificationText<T extends { kind: string; title: string; body: string }>(
  notification: T,
): { title: string; body: string } {
  const match =
    notification.kind === "run_failed"
      ? /^(.+? couldn't finish):\s+(.+?)\.?$/.exec(notification.title)
      : null;
  if (!match) return { title: notification.title, body: notification.body };
  return {
    title: `${match[1]} “${match[2]!.replace(/^["“]|["”]$/g, "")}”`,
    body: notification.body,
  };
}

/** Where something a notification asked of you stands now, for the label under it. */
export type NotificationState =
  | { kind: "approval"; status: "pending" | "approved" | "denied" | "expired" }
  | { kind: "takeover"; status: "pending" };

/**
 * Where a notification that asked something of you stands: an approval by the request it was
 * about (the one in its run made closest before it), a takeover while it still waits. Null for
 * everything else, and for a takeover that's over (how it ended isn't known here).
 */
export function notificationState(
  notification: { kind: string; runId: string | null; botId: string | null; createdAt: string },
  approvals: { runId: string; status: string; createdAt: string }[],
  takeovers: { botId: string | null }[],
): NotificationState | null {
  if (notification.kind === "approval" && notification.runId) {
    const at = new Date(notification.createdAt).getTime();
    const near = (iso: string) => Math.abs(new Date(iso).getTime() - at);
    const match = approvals
      .filter((approval) => approval.runId === notification.runId)
      .sort((a, b) => near(a.createdAt) - near(b.createdAt))[0];
    if (!match) return null;
    const status = match.status;
    return status === "pending" ||
      status === "approved" ||
      status === "denied" ||
      status === "expired"
      ? { kind: "approval", status }
      : null;
  }
  if (
    notification.kind === "takeover_request" &&
    takeovers.some((request) => request.botId !== null && request.botId === notification.botId)
  )
    return { kind: "takeover", status: "pending" };
  return null;
}

/** Whether a notification still needs you: a request not yet decided, or a limit or phone question unread. */
export function stillNeedsYou(
  notification: { kind: string; readAt: string | null },
  state: NotificationState | null,
): boolean {
  if (state) return state.status === "pending";
  return (
    (notification.kind === "cap_reached" || notification.kind === "egress_unanswered") &&
    !notification.readAt
  );
}
