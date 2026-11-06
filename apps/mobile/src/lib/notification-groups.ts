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
