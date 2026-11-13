import { b64url, empty, type Exchange, id16, json, jsonBody } from "./http";
import { googleAuth, googleError, GoogleStandIn, SCOPES } from "./google";

// ---------------------------------------------------------------------------------------------
// Google Calendar

export interface CalendarEvent {
  id: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: {
    email: string;
    responseStatus: string;
    self?: boolean;
    organizer?: boolean;
    comment?: string;
    optional?: boolean;
    resource?: boolean;
  }[];
  [key: string]: unknown;
}

export interface CalendarWrite {
  method: string;
  calendarId: string;
  eventId: string | null;
  sendUpdates: string | null;
  ifMatch: string | null;
  body: Record<string, unknown> | null;
  status: number;
}

const CALENDAR_READ = [SCOPES.calendarRead, SCOPES.calendarEvents] as const;

const CALENDAR_WRITE = [SCOPES.calendarEvents] as const;

const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";

/** The signed-in user's calendars, with Calendar's REST API over them. */
export class CalendarStandIn {
  readonly events = new Map<string, Map<string, CalendarEvent>>();
  /** Every change asked for, and how it was answered. */
  readonly writes: CalendarWrite[] = [];
  private etags = 0;

  constructor(
    private readonly google: GoogleStandIn,
    private readonly owner: () => string,
  ) {}

  private calendar(id: string): Map<string, CalendarEvent> | null {
    const resolved = id === "primary" ? this.owner() : id;
    if (resolved !== this.owner() && resolved !== HOLIDAYS) return null;
    let events = this.events.get(resolved);
    if (!events) {
      events = new Map();
      this.events.set(resolved, events);
    }
    return events;
  }

  private etag() {
    this.etags += 1;
    return `"${3_500_000_000_000_000 + this.etags}"`;
  }

  /** An event already on the primary calendar. */
  addEvent(input: {
    summary: string;
    start: Date;
    end: Date;
    guests?: string[];
    description?: string;
    location?: string;
    id?: string;
    /** Someone else's event the user is invited to, rather than the user's own. */
    organizer?: string;
  }): CalendarEvent {
    const event = this.build(
      {
        id: input.id ?? id16(),
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString() },
        end: { dateTime: input.end.toISOString() },
        attendees: (input.guests ?? []).map((email) => ({ email })),
      },
      "0",
    );
    if (input.organizer) {
      event.organizer = { email: input.organizer };
      event.creator = { email: input.organizer };
      event.attendees = [
        { email: input.organizer, organizer: true, responseStatus: "accepted" },
        ...(input.guests ?? []).map((email) => ({ email, responseStatus: "needsAction" })),
        { email: this.owner(), self: true, responseStatus: "needsAction" },
      ];
    }
    this.calendar("primary")!.set(event.id, event);
    return event;
  }

  /** The live event on the primary calendar whose title has this in it, in any case. */
  find(title: string): CalendarEvent | undefined {
    const wanted = title.toLowerCase();
    return [...(this.calendar("primary")?.values() ?? [])].find(
      (event) =>
        event.status !== "cancelled" && (event.summary ?? "").toLowerCase().includes(wanted),
    );
  }

  private attendees(list: unknown, existing: CalendarEvent["attendees"] = []) {
    if (!Array.isArray(list)) return undefined;
    const owner = this.owner().toLowerCase();
    const before = new Map(existing.map((guest) => [guest.email.toLowerCase(), guest]));
    const guests = (list as Record<string, unknown>[])
      .filter((guest) => typeof guest.email === "string")
      .map((guest) => {
        const email = String(guest.email);
        const self = email.toLowerCase() === owner;
        return {
          ...before.get(email.toLowerCase()),
          ...guest,
          email,
          responseStatus: String(
            guest.responseStatus ??
              before.get(email.toLowerCase())?.responseStatus ??
              (self ? "accepted" : "needsAction"),
          ),
          ...(self ? { self: true, organizer: true } : {}),
        };
      });
    // Google lists the organizer among the guests once anyone else is invited.
    if (guests.length && !guests.some((guest) => guest.email.toLowerCase() === owner))
      guests.unshift({
        email: this.owner(),
        responseStatus: "accepted",
        self: true,
        organizer: true,
      });
    return guests;
  }

  private build(body: Record<string, unknown>, conferenceDataVersion: string): CalendarEvent {
    const id = String(body.id);
    const now = new Date().toISOString();
    const create = (body.conferenceData as { createRequest?: Record<string, unknown> } | undefined)
      ?.createRequest;
    const meet = `https://meet.google.com/e2e-${id.slice(0, 4)}-${id.slice(4, 8)}`;
    const attendees = this.attendees(body.attendees);
    return {
      ...body,
      kind: "calendar#event",
      id,
      etag: this.etag(),
      status: "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${b64url(`${id} ${this.owner()}`)}`,
      created: now,
      updated: now,
      iCalUID: `${id}@google.com`,
      sequence: 0,
      creator: { email: this.owner(), self: true },
      organizer: { email: this.owner(), self: true },
      start: body.start as CalendarEvent["start"],
      end: body.end as CalendarEvent["end"],
      ...(attendees ? { attendees } : {}),
      ...(create && conferenceDataVersion === "1"
        ? {
            hangoutLink: meet,
            conferenceData: {
              createRequest: { ...create, status: { statusCode: "success" } },
              entryPoints: [{ entryPointType: "video", uri: meet, label: meet.slice(8) }],
              conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
              conferenceId: meet.split("/").pop(),
            },
          }
        : { conferenceData: undefined }),
    } as CalendarEvent;
  }

  handle(ex: Exchange): boolean {
    const prefix = "/calendar/v3";
    if (!ex.url.pathname.startsWith(`${prefix}/`)) return false;
    const path = ex.url.pathname.slice(prefix.length);
    if (ex.method === "GET" && path === "/users/me/calendarList") {
      if (!googleAuth(this.google, ex, CALENDAR_READ)) return true;
      json(ex, 200, {
        kind: "calendar#calendarList",
        items: [
          {
            id: this.owner(),
            summary: this.owner(),
            primary: true,
            accessRole: "owner",
            timeZone: "Europe/Berlin",
          },
          { id: HOLIDAYS, summary: "Holidays", accessRole: "reader", timeZone: "Europe/Berlin" },
        ],
      });
      return true;
    }
    if (ex.method === "POST" && path === "/freeBusy") {
      if (!googleAuth(this.google, ex, CALENDAR_READ)) return true;
      this.freeBusy(ex);
      return true;
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!match) {
      googleError(ex, 404, "Not Found");
      return true;
    }
    const calendarId = decodeURIComponent(match[1]!);
    const eventId = match[2] ? decodeURIComponent(match[2]) : null;
    const reading = ex.method === "GET";
    if (!googleAuth(this.google, ex, reading ? CALENDAR_READ : CALENDAR_WRITE)) return true;
    const events = this.calendar(calendarId);
    if (!events) {
      googleError(ex, 404, "Not Found", "notFound");
      return true;
    }
    if (!reading && calendarId === HOLIDAYS) {
      googleError(
        ex,
        403,
        "You need to have writer access to this calendar.",
        "requiredAccessLevel",
      );
      return true;
    }
    if (ex.method === "GET" && !eventId) this.list(ex, events);
    else if (ex.method === "GET") {
      const event = events.get(eventId!);
      if (event) json(ex, 200, event);
      else googleError(ex, 404, "Not Found", "notFound");
    } else this.write(ex, calendarId, eventId, events);
    return true;
  }

  private list(ex: Exchange, events: Map<string, CalendarEvent>) {
    const params = ex.url.searchParams;
    const from = Date.parse(params.get("timeMin") ?? "") || -Infinity;
    const to = Date.parse(params.get("timeMax") ?? "") || Infinity;
    const q = (params.get("q") ?? "").toLowerCase();
    const max = Math.min(Number(params.get("maxResults") ?? 250) || 250, 2500);
    const items = [...events.values()]
      .filter((event) => params.get("showDeleted") === "true" || event.status !== "cancelled")
      .filter((event) => startOf(event) < to && endOf(event) > from)
      .filter(
        (event) =>
          !q ||
          `${event.summary ?? ""} ${event.description ?? ""} ${event.location ?? ""}`
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) => startOf(a) - startOf(b))
      .slice(0, max);
    json(ex, 200, {
      kind: "calendar#events",
      summary: this.owner(),
      timeZone: "Europe/Berlin",
      items,
    });
  }

  private freeBusy(ex: Exchange) {
    const body = jsonBody(ex);
    const from = Date.parse(String(body.timeMin ?? ""));
    const to = Date.parse(String(body.timeMax ?? ""));
    const calendars: Record<string, unknown> = {};
    for (const item of (body.items as { id?: string }[] | undefined) ?? []) {
      const id = String(item.id ?? "");
      const events = this.calendar(id);
      calendars[id] = events
        ? {
            busy: [...events.values()]
              .filter(
                (event) => event.status !== "cancelled" && event.transparency !== "transparent",
              )
              .filter((event) => startOf(event) < to && endOf(event) > from)
              .sort((a, b) => startOf(a) - startOf(b))
              .map((event) => ({
                start: new Date(startOf(event)).toISOString(),
                end: new Date(endOf(event)).toISOString(),
              })),
          }
        : { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
    }
    json(ex, 200, {
      kind: "calendar#freeBusy",
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars,
    });
  }

  private write(
    ex: Exchange,
    calendarId: string,
    eventId: string | null,
    events: Map<string, CalendarEvent>,
  ) {
    const params = ex.url.searchParams;
    const body = ex.method === "DELETE" ? null : jsonBody(ex);
    const record: CalendarWrite = {
      method: ex.method,
      calendarId,
      eventId: eventId ?? (typeof body?.id === "string" ? body.id : null),
      sendUpdates: params.get("sendUpdates"),
      ifMatch: (ex.req.headers["if-match"] as string | undefined) ?? null,
      body,
      status: 0,
    };
    this.writes.push(record);
    const answer = (status: number, message?: string, reason?: string, result?: unknown) => {
      record.status = status;
      if (status === 204) empty(ex);
      else if (message) googleError(ex, status, message, reason);
      else json(ex, status, result);
    };
    if (ex.method === "POST" && !eventId) {
      const id = typeof body!.id === "string" ? body!.id : id16();
      if (!/^[a-v0-9]{5,1024}$/.test(id))
        return answer(400, "Invalid resource id value.", "invalid");
      if (events.has(id))
        return answer(409, "The requested identifier already exists.", "duplicate");
      const problem = timeProblem(body!);
      if (problem) return answer(400, problem, "required");
      const event = this.build({ ...body, id }, params.get("conferenceDataVersion") ?? "0");
      events.set(id, event);
      return answer(200, undefined, undefined, event);
    }
    const event = eventId ? events.get(eventId) : undefined;
    if (!event) return answer(404, "Not Found", "notFound");
    if (event.status === "cancelled") return answer(410, "Resource has been deleted", "deleted");
    if (record.ifMatch && record.ifMatch !== event.etag)
      return answer(412, "Precondition Failed", "conditionNotMet");
    if (ex.method === "DELETE") {
      event.status = "cancelled";
      event.etag = this.etag();
      return answer(204);
    }
    if (ex.method !== "PATCH" && ex.method !== "PUT") return answer(404, "Not Found");
    const next: Record<string, unknown> = ex.method === "PUT" ? { id: event.id } : { ...event };
    for (const [key, value] of Object.entries(body!)) {
      if (key === "id" || key === "etag") continue;
      if (value === null) delete next[key];
      else next[key] = key === "attendees" ? this.attendees(value, event.attendees) : value;
    }
    const problem = timeProblem(next);
    if (problem) return answer(400, problem, "required");
    const updated = {
      ...next,
      etag: this.etag(),
      updated: new Date().toISOString(),
      sequence: Number(event.sequence ?? 0) + 1,
    } as unknown as CalendarEvent;
    events.set(event.id, updated);
    return answer(200, undefined, undefined, updated);
  }
}

function instant(time: CalendarEvent["start"] | undefined): number {
  if (!time) return NaN;
  return Date.parse(time.dateTime ?? (time.date ? `${time.date}T00:00:00Z` : ""));
}

function startOf(event: CalendarEvent) {
  return instant(event.start);
}

function endOf(event: CalendarEvent) {
  return instant(event.end);
}

function timeProblem(body: Record<string, unknown>): string | null {
  const start = body.start as CalendarEvent["start"] | undefined;
  const end = body.end as CalendarEvent["end"] | undefined;
  if (!start || (!start.dateTime && !start.date)) return "Missing start time.";
  if (!end || (!end.dateTime && !end.date)) return "Missing end time.";
  const from = instant(start);
  const to = instant(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return "Invalid start or end time.";
  if (to <= from) return "The specified time range is empty.";
  return null;
}
