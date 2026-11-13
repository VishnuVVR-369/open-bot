import { phoneClock } from "../../lib/phone-clock";

/** A pause this long between two turns earns a time stamp, as in a messaging app. */
const STAMP_GAP_MS = 60 * 60_000;

/**
 * The time stamp above an entry, when it's the first one or comes a while after the one before:
 * "Today 10:29 PM", "Yesterday 9:03 AM", "Mon 2 Nov, 10:29 PM".
 */
export function timeStamp(at: string, before: string | undefined): string | null {
  const when = new Date(at);
  if (before && when.getTime() - new Date(before).getTime() < STAMP_GAP_MS) {
    const previous = new Date(before);
    if (previous.toDateString() === when.toDateString()) return null;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  const time = phoneClock(at);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = when.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(when.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}
