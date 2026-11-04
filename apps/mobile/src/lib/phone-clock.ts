import { getCalendars } from "expo-localization";
import { clock, dayClock } from "./time";

const twelveHour = () => getCalendars()[0]?.uses24hourClock === false;

/** A time of day the way the phone shows it, following its 12 or 24-hour setting. */
export function phoneClock(iso: string): string {
  return clock(iso, twelveHour());
}

/** The time, with the day when it wasn't today, the way the phone shows times. */
export function phoneDayClock(iso: string): string {
  return dayClock(iso, twelveHour());
}
