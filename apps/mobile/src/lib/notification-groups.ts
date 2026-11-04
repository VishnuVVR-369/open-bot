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
