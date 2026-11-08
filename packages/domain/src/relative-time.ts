/**
 * When something happened, short, the same on the web and the phone: "just now", "5m ago",
 * "4h ago" today, then "yesterday", a weekday ("Mon") within the week, and a date ("Oct 12",
 * "Oct 12, 2025") before that. In the viewer's own time zone.
 */
export function relativeTime(iso: string | Date, now: number = Date.now()): string {
  const then = new Date(iso);
  const seconds = Math.max(0, Math.floor((now - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (then.getTime() >= today.getTime()) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.ceil((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return then.toLocaleDateString("en-US", { weekday: "short" });
  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
