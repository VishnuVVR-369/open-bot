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

/** 14:05 today, "Mon 14:05" earlier: when something in a list happened. */
export function dayClock(iso: string, twelveHour = false, now = Date.now()): string {
  const date = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const time = clock(iso, twelveHour);
  if (date.getTime() >= today.getTime()) return time;
  return `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
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

/**
 * When a teammate last worked, as a phrase: "Active just now", "Active 5m ago", "Active 3h ago",
 * "Active yesterday", "Active Mon", "Active 12 Oct".
 */
export function lastActive(iso: string, now = Date.now()): string {
  return since("Active", iso, now);
}

/** When a screen was last captured: "Last seen 4h ago", "Last seen yesterday". */
export function lastSeen(iso: string, now = Date.now()): string {
  return since("Last seen", iso, now);
}

function since(lead: string, iso: string, now: number): string {
  const when = ago(iso, now);
  if (when === "now") return `${lead} just now`;
  if (/^\d+[mh]$/.test(when)) return `${lead} ${when} ago`;
  return `${lead} ${when === "Yesterday" ? "yesterday" : when}`;
}
