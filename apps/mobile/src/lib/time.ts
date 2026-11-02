/** Times as the web shows them, without a date library. */

const pad = (n: number) => String(n).padStart(2, "0");

/** 14:05, or 2:05 PM on a phone set to the 12-hour clock. */
export function clock(iso: string, twelveHour = false): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = pad(date.getMinutes());
  if (!twelveHour) return `${pad(hours)}:${minutes}`;
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** "now", "5m", "3h", "Yesterday", "Mon", "12 Oct", for lists. */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  const seconds = Math.max(0, Math.floor((now - then.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (then.getTime() >= today.getTime()) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.ceil((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString("en-GB", { weekday: "short" });
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** 42s, 3m 05s */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
}
