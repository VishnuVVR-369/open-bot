import { googleEndpoints } from "../../../core/endpoints";
import type { ProviderError, TokenSource } from "../../../core/http";
import { providerJson } from "../http";
import { isoInZone, readableTime } from "./time";

/** Google Calendar's REST API: its shapes, the client for one account, and how events read. */

export interface Attendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  comment?: string;
  resource?: boolean;
}

export interface EventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
  organizer?: { email?: string; self?: boolean };
  recurringEventId?: string;
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
}

const MAX_DESCRIPTION = 4_000;
/** Google Calendar's API, for one account. */
export class CalendarApi {
  private readonly base = googleEndpoints().calendar;
  constructor(private readonly tokens: TokenSource) {}

  async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return (await providerJson<T>(this.tokens, { url: `${this.base}${path}`, query, mode: "read" }))
      .body;
  }

  async read<T>(path: string, body: unknown): Promise<T> {
    return (
      await providerJson<T>(this.tokens, {
        method: "POST",
        url: `${this.base}${path}`,
        body,
        mode: "read",
      })
    ).body;
  }

  async write<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      etag?: string;
    } = {},
  ): Promise<T> {
    return (
      await providerJson<T>(this.tokens, {
        method,
        url: `${this.base}${path}`,
        body: options.body,
        query: options.query,
        headers: options.etag ? { "if-match": options.etag } : {},
        mode: "write",
      })
    ).body;
  }
}

export const eventPath = (calendarId: string, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;

/** The refusal as the teammate reads it. */
export function calendarProblem(error: ProviderError): string {
  if (error.reason === "accessNotConfigured" || error.reason === "SERVICE_DISABLED")
    return "The Google Calendar API isn't enabled in the user's Google Cloud project. Ask them to enable it (APIs & Services → Library → Google Calendar API), then try again.";
  if (error.status === 412)
    return "The event changed since this was planned. Read it again, and plan the change anew.";
  if (error.status === 404 || error.status === 410)
    return "Google Calendar has no such event or calendar.";
  if (error.status === 403)
    return `Google Calendar refused it: ${error.message} The user may need to reconnect Google Calendar in Settings → Connections and allow it.`;
  return `Google Calendar: ${error.message}`;
}

export function guestEmails(event: Pick<CalendarEvent, "attendees"> | undefined): string[] {
  return (event?.attendees ?? []).filter((guest) => !guest.resource).map((guest) => guest.email);
}

/** How an event's time reads, in your zone. */
export function when(event: CalendarEvent, timeZone: string): string {
  if (event.start?.date) {
    const end = event.end?.date ? ` to ${event.end.date} (exclusive)` : "";
    return `all day ${event.start.date}${end}`;
  }
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start) return "(no time)";
  return `${readableTime(start, timeZone)}${end ? `-${readableTime(end, timeZone).split(", ").pop()}` : ""} (${isoInZone(start, timeZone)}${end ? ` to ${isoInZone(end, timeZone)}` : ""})`;
}

export function eventLine(event: CalendarEvent, calendarId: string, timeZone: string): string {
  const me = event.attendees?.find((guest) => guest.self);
  const guests = guestEmails(event);
  return [
    `- ${when(event, timeZone)}: “${event.summary ?? "(no title)"}” (event_id ${event.id}${calendarId === "primary" ? "" : `, calendar_id ${calendarId}`})`,
    event.location ? ` · ${event.location}` : "",
    guests.length ? ` · ${guests.length} guest${guests.length === 1 ? "" : "s"}` : "",
    me?.responseStatus && me.responseStatus !== "accepted" && !me.organizer
      ? ` · you: ${me.responseStatus}`
      : "",
    event.recurringEventId ? " · repeats" : "",
  ].join("");
}

/** An event in full, as a teammate reads it: when, where, who, and what it says. */
export function eventDetails(event: CalendarEvent, timeZone: string): string {
  const meet =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  const lines = [
    `Title: ${event.summary ?? "(no title)"}`,
    `When: ${when(event, timeZone)}`,
    ...(event.location ? [`Where: ${event.location}`] : []),
    ...(meet ? [`Video call: ${meet}`] : []),
    ...(event.organizer?.email
      ? [`Organizer: ${event.organizer.email}${event.organizer.self ? " (the user)" : ""}`]
      : []),
    ...(event.attendees?.length
      ? [
          `Guests: ${event.attendees
            .map(
              (guest) =>
                `${guest.email}${guest.self ? " (the user)" : ""}: ${guest.responseStatus ?? "needsAction"}`,
            )
            .join(", ")}`,
        ]
      : []),
    ...(event.recurringEventId ? ["It's one occurrence of a repeating event."] : []),
    ...(event.htmlLink ? [`Link: ${event.htmlLink}`] : []),
    "",
    (event.description ?? "").slice(0, MAX_DESCRIPTION),
  ];
  return lines.join("\n").trim();
}
