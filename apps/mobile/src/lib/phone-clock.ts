import { getCalendars } from "expo-localization";
import { clock } from "./time";

/** A time of day the way the phone shows it, following its 12 or 24-hour setting. */
export function phoneClock(iso: string): string {
  return clock(iso, getCalendars()[0]?.uses24hourClock === false);
}
