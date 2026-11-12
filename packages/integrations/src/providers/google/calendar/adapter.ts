import { ownerTimeZone } from "@open-bot/db";
import { outsideData, type AccountActionPreview } from "@open-bot/domain";
import { z } from "zod";
import { AccountToolError } from "../../../core/errors";
import { ProviderError, type TokenSource } from "../../../core/http";
import {
  CalendarApi,
  calendarProblem,
  eventDetails,
  eventLine,
  eventPath,
  guestEmails,
  when,
  type Attendee,
  type CalendarEvent,
  type EventTime,
} from "./api";
import { calendarEffect } from "./effects";
import {
  emails as emailsSchema,
  namespace,
  time,
  tool,
  type JsonSchema,
  type NamespaceTool,
} from "../../../core/tool-spec";
import { freeTime, isoInZone, readableTime, type WorkingHours } from "./time";
import type {
  ActionOutcome,
  ActionRow,
  ActionRunner,
  IntegrationAdapter,
  PreparedAction,
  ToolContext,
  ResolvedConnection,
  IntegrationHost,
  ToolResult,
} from "../../../core/adapter";

const MAX_RESULT_TEXT = 100_000;

const accountArg = z.string().optional();
const calendarArg = z.string().trim().min(1).default("primary");
const instant = z
  .string()
  .trim()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Use RFC 3339, like 2026-11-06T10:00:00+01:00.",
  );
const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-06.");
const emails = z.array(z.string().trim().email("That isn't an email address.")).max(100);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, like 09:00.");

const timing = {
  start: z.string().trim().optional(),
  end: z.string().trim().optional(),
  all_day: z.boolean().optional(),
  time_zone: z.string().trim().optional(),
};

const schemas = {
  list_calendars: z.object({ account: accountArg }),
  list_events: z.object({
    calendar_ids: z.array(z.string().trim().min(1)).min(1).max(20).default(["primary"]),
    from: instant.optional(),
    to: instant.optional(),
    query: z.string().trim().max(200).optional(),
    max_results: z.number().int().min(1).max(250).default(50),
    account: accountArg,
  }),
  get_event: z.object({
    calendar_id: calendarArg,
    event_id: z.string().trim().min(1),
    account: accountArg,
  }),
  find_free_time: z.object({
    minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    from: instant.optional(),
    to: instant.optional(),
    calendar_ids: z.array(z.string().trim().min(1)).min(1).max(20).default(["primary"]),
    working_hours: z
      .object({
        start: hhmm.default("09:00"),
        end: hhmm.default("18:00"),
        days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
      })
      .nullable()
      .optional(),
    max_results: z.number().int().min(1).max(50).default(10),
    account: accountArg,
  }),
  create_event: z.object({
    calendar_id: calendarArg,
    title: z.string().trim().min(1).max(300),
    ...timing,
    start: z.string().trim(),
    end: z.string().trim(),
    location: z.string().trim().max(500).optional(),
    description: z.string().max(8000).optional(),
    guests: emails.default([]),
    add_meet: z.boolean().default(false),
    reminders_minutes: z.array(z.number().int().min(0).max(40320)).max(5).optional(),
    account: accountArg,
  }),
  update_event: z.object({
    calendar_id: calendarArg,
    event_id: z.string().trim().min(1),
    title: z.string().trim().min(1).max(300).optional(),
    ...timing,
    location: z.string().trim().max(500).optional(),
    description: z.string().max(8000).optional(),
    guests: emails.optional(),
    add_guests: emails.default([]),
    remove_guests: emails.default([]),
    account: accountArg,
  }),
  delete_event: z.object({
    calendar_id: calendarArg,
    event_id: z.string().trim().min(1),
    account: accountArg,
  }),
  respond: z.object({
    calendar_id: calendarArg,
    event_id: z.string().trim().min(1),
    response: z.enum(["accepted", "declined", "tentative"]),
    note: z.string().trim().max(500).optional(),
    account: accountArg,
  }),
};

/** A start and end, as Google takes them: dates for all-day events, instants otherwise. */
function times(
  input: { start?: string; end?: string; all_day?: boolean; time_zone?: string },
  timeZone: string,
): { start: EventTime; end: EventTime } | null {
  if (input.start === undefined && input.end === undefined) return null;
  if (input.start === undefined || input.end === undefined)
    throw new AccountToolError("Give both start and end.");
  if (input.all_day) {
    day.parse(input.start);
    day.parse(input.end);
    if (input.end <= input.start)
      throw new AccountToolError("For all-day events, end is the day after the last day.");
    return { start: { date: input.start }, end: { date: input.end } };
  }
  const start = instant.parse(input.start);
  const end = instant.parse(input.end);
  if (Date.parse(end) <= Date.parse(start))
    throw new AccountToolError("The event has to end after it starts.");
  const zone = input.time_zone ?? timeZone;
  return {
    start: { dateTime: new Date(start).toISOString(), timeZone: zone },
    end: { dateTime: new Date(end).toISOString(), timeZone: zone },
  };
}

function eventPreview(input: {
  account: string;
  change: "create" | "update" | "delete" | "respond";
  event: Pick<CalendarEvent, "summary" | "start" | "end" | "location">;
  guests: string[];
  notifiesGuests: boolean;
  calendar: string;
  timeZone: string;
  response?: "accepted" | "declined" | "tentative";
}): AccountActionPreview {
  const { event } = input;
  return {
    type: "event",
    account: input.account,
    change: input.change,
    title: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    allDay: Boolean(event.start?.date),
    timeZone: event.start?.timeZone ?? input.timeZone,
    ...(event.location ? { location: event.location } : {}),
    guests: input.guests,
    notifiesGuests: input.notifiesGuests,
    ...(input.response ? { response: input.response } : {}),
    ...(input.calendar !== "primary" ? { calendar: input.calendar } : {}),
  };
}

/** A Calendar event id from an action id: Google takes base32hex, which hex digits are. */
export function eventIdFor(actionId: string): string {
  return actionId.replace(/-/g, "").toLowerCase();
}

const timingSchema: Record<string, JsonSchema> = {
  start: time(
    "RFC 3339 with an offset, like 2026-11-06T10:00:00+01:00; for all_day, a date like 2026-11-06.",
  ),
  end: time("Same form as start. For all_day, the day after the last day."),
  all_day: { type: "boolean" },
  time_zone: {
    type: "string",
    description: "IANA zone for the event, like Europe/Berlin. Default: the user's.",
  },
};

const CALENDAR_TOOLS: NamespaceTool[] = [
  tool("list_calendars", "List the user's calendars, with ids, names, and which is primary.", {}),
  tool(
    "list_events",
    "List events in a window (default: the next 7 days), across calendars (default: primary), with an optional text query. Repeating events come as their occurrences.",
    {
      calendar_ids: {
        type: "array",
        items: { type: "string" },
        description: 'Default ["primary"].',
      },
      from: time("RFC 3339. Default: now."),
      to: time("RFC 3339. Default: 7 days after from."),
      query: { type: "string" },
      max_results: { type: "integer", minimum: 1, maximum: 250 },
    },
  ),
  tool(
    "get_event",
    "One event in full: guests and their answers, the video call link, and the description.",
    {
      calendar_id: { type: "string", description: 'Default "primary".' },
      event_id: { type: "string" },
    },
    ["event_id"],
  ),
  tool(
    "find_free_time",
    "Find free stretches of at least `minutes` in a window (default the next 7 days), across calendars, within working hours (default 09:00-18:00, Monday to Friday, in the user's time zone; pass null for any hour).",
    {
      minutes: { type: "integer", minimum: 5, maximum: 1440 },
      from: time("RFC 3339. Default: now."),
      to: time("RFC 3339. Default: 7 days after from."),
      calendar_ids: { type: "array", items: { type: "string" } },
      working_hours: {
        type: ["object", "null"],
        properties: {
          start: { type: "string", description: "HH:MM" },
          end: { type: "string", description: "HH:MM" },
          days: {
            type: "array",
            items: { type: "integer", minimum: 1, maximum: 7 },
            description: "ISO weekdays, 1 is Monday.",
          },
        },
        additionalProperties: false,
      },
      max_results: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["minutes"],
  ),
  tool(
    "create_event",
    "Add an event to the user's calendar. With guests, Google emails them an invitation, so it asks the user first.",
    {
      calendar_id: { type: "string", description: 'Default "primary".' },
      title: { type: "string" },
      ...timingSchema,
      location: { type: "string" },
      description: { type: "string" },
      guests: emailsSchema("Guests to invite."),
      add_meet: { type: "boolean", description: "Add a Google Meet link." },
      reminders_minutes: {
        type: "array",
        items: { type: "integer" },
        description: "Pop-up reminders, minutes before.",
      },
    },
    ["title", "start", "end"],
  ),
  tool(
    "update_event",
    "Change an event: give only what changes. If it has guests (before or after), Google emails them, so it asks the user first. It fails if the event changed since you read it.",
    {
      calendar_id: { type: "string" },
      event_id: { type: "string" },
      title: { type: "string" },
      ...timingSchema,
      location: { type: "string" },
      description: { type: "string" },
      guests: emailsSchema("The full new guest list."),
      add_guests: emailsSchema("Guests to add."),
      remove_guests: emailsSchema("Guests to remove."),
    },
    ["event_id"],
  ),
  tool(
    "delete_event",
    "Delete an event. Guests get a cancellation. It asks the user first.",
    { calendar_id: { type: "string" }, event_id: { type: "string" } },
    ["event_id"],
  ),
  tool(
    "respond",
    "Answer an invitation as the user: accepted, declined or tentative, with an optional note to the organizer. It asks the user first.",
    {
      calendar_id: { type: "string" },
      event_id: { type: "string" },
      response: { type: "string", enum: ["accepted", "declined", "tentative"] },
      note: { type: "string" },
    },
    ["event_id", "response"],
  ),
];

/** Google Calendar for teammates. */
export class CalendarTools implements IntegrationAdapter {
  static readonly spec = namespace(
    "google_calendar",
    "The user's Google Calendar: read events, find free time, and add or change events. Anything that emails guests asks the user first.",
    CALENDAR_TOOLS,
  );
  readonly kind = "google_calendar" as const;

  constructor(private readonly host: IntegrationHost) {}

  problem(error: ProviderError): string {
    return calendarProblem(error);
  }

  /** A cheap call that proves the connection works, for Settings' Test. */
  async probe(_resolved: ResolvedConnection, tokens: TokenSource): Promise<string> {
    const { items = [] } = await new CalendarApi(tokens).get<{ items?: unknown[] }>(
      "/users/me/calendarList",
      {
        maxResults: 250,
      },
    );
    return `${items.length} calendar${items.length === 1 ? "" : "s"}`;
  }

  async call(tool: string, tc: ToolContext): Promise<ToolResult> {
    const api = new CalendarApi(tc.tokens);
    const timeZone = await ownerTimeZone(this.host.db);
    switch (tool) {
      case "list_calendars":
        return this.listCalendars(api);
      case "list_events":
        return this.listEvents(api, schemas.list_events.parse(tc.args), timeZone);
      case "get_event":
        return this.getEvent(api, schemas.get_event.parse(tc.args), timeZone);
      case "find_free_time":
        return this.findFreeTime(api, schemas.find_free_time.parse(tc.args), timeZone);
      case "create_event":
        return {
          type: "action",
          action: this.createEvent(tc, schemas.create_event.parse(tc.args), timeZone),
        };
      case "update_event":
        return {
          type: "action",
          action: await this.updateEvent(api, tc, schemas.update_event.parse(tc.args), timeZone),
        };
      case "delete_event":
        return {
          type: "action",
          action: await this.deleteEvent(api, tc, schemas.delete_event.parse(tc.args), timeZone),
        };
      case "respond":
        return {
          type: "action",
          action: await this.respond(api, tc, schemas.respond.parse(tc.args), timeZone),
        };
      default:
        throw new AccountToolError(`Google Calendar has no tool ${tool}.`);
    }
  }

  private async listCalendars(api: CalendarApi): Promise<ToolResult> {
    const { items = [] } = await api.get<{
      items?: {
        id: string;
        summary: string;
        primary?: boolean;
        accessRole: string;
        timeZone?: string;
      }[];
    }>("/users/me/calendarList");
    return {
      type: "read",
      outside: false,
      label: "Listed calendars",
      summary: `${items.length} calendars`,
      text:
        items
          .map(
            (calendar) =>
              `- ${calendar.summary}${calendar.primary ? " (primary)" : ""}: calendar_id ${calendar.primary ? "primary" : calendar.id}, ${calendar.accessRole}${calendar.timeZone ? `, ${calendar.timeZone}` : ""}`,
          )
          .join("\n") || "No calendars.",
    };
  }

  private async listEvents(
    api: CalendarApi,
    args: z.infer<typeof schemas.list_events>,
    timeZone: string,
  ): Promise<ToolResult> {
    const from = args.from ? new Date(args.from) : new Date();
    const to = args.to ? new Date(args.to) : new Date(from.getTime() + 7 * 24 * 60 * 60_000);
    if (to <= from) throw new AccountToolError("`to` has to be after `from`.");
    const lists = await Promise.all(
      args.calendar_ids.map(async (calendarId) => {
        const { items = [] } = await api.get<{ items?: CalendarEvent[] }>(eventPath(calendarId), {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: args.max_results,
          q: args.query,
        });
        return items
          .filter((event) => event.status !== "cancelled")
          .map((event) => ({ event, calendarId }));
      }),
    );
    const events = lists
      .flat()
      .sort((a, b) => start(a.event) - start(b.event))
      .slice(0, args.max_results);
    const window = `${readableTime(from, timeZone)} to ${readableTime(to, timeZone)}`;
    return {
      type: "read",
      outside: events.length > 0,
      label: args.query ? `Looked for “${args.query}” in your calendar` : "Looked at your calendar",
      summary: `${events.length} event${events.length === 1 ? "" : "s"}`,
      text: events.length
        ? outsideData(
            `From Google Calendar: ${events.length} events from ${window} (${timeZone}). Titles and places can be written by anyone who invites the user`,
            events
              .map(({ event, calendarId }) => eventLine(event, calendarId, timeZone))
              .join("\n")
              .slice(0, MAX_RESULT_TEXT),
          )
        : `No events from ${window}${args.query ? ` matching “${args.query}”` : ""}.`,
    };
  }

  private async getEvent(
    api: CalendarApi,
    args: z.infer<typeof schemas.get_event>,
    timeZone: string,
  ): Promise<ToolResult> {
    const event = await api.get<CalendarEvent>(eventPath(args.calendar_id, args.event_id));
    return {
      type: "read",
      outside: true,
      label: `Read “${event.summary ?? "an event"}”`.slice(0, 120),
      text: outsideData(`From Google Calendar: event ${event.id}`, eventDetails(event, timeZone)),
    };
  }

  private async findFreeTime(
    api: CalendarApi,
    args: z.infer<typeof schemas.find_free_time>,
    timeZone: string,
  ): Promise<ToolResult> {
    const from = args.from ? new Date(args.from) : new Date();
    const to = args.to ? new Date(args.to) : new Date(from.getTime() + 7 * 24 * 60 * 60_000);
    if (to <= from) throw new AccountToolError("`to` has to be after `from`.");
    const response = await api.read<{
      calendars?: Record<
        string,
        { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }
      >;
    }>("/freeBusy", {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone,
      items: args.calendar_ids.map((id) => ({ id })),
    });
    const calendars = response.calendars ?? {};
    const failed = Object.entries(calendars).filter(([, entry]) => entry.errors?.length);
    if (failed.length)
      throw new AccountToolError(
        `Couldn't read ${failed.map(([id]) => id).join(", ")}: ${failed[0]![1].errors![0]!.reason}.`,
      );
    const busy = Object.values(calendars).flatMap((entry) =>
      (entry.busy ?? []).map((block) => ({
        start: new Date(block.start),
        end: new Date(block.end),
      })),
    );
    const hours: WorkingHours | null =
      args.working_hours === null
        ? null
        : {
            start: args.working_hours?.start ?? "09:00",
            end: args.working_hours?.end ?? "18:00",
            days: args.working_hours?.days ?? [1, 2, 3, 4, 5],
          };
    const slots = freeTime({
      busy,
      from,
      to,
      minutes: args.minutes,
      timeZone,
      hours,
      max: args.max_results,
    });
    const scope = hours
      ? `within ${hours.start}-${hours.end} on ${hours.days.join(",")} (ISO weekdays)`
      : "at any hour";
    return {
      type: "read",
      outside: false,
      label: `Found ${slots.length} free slot${slots.length === 1 ? "" : "s"}`,
      text: slots.length
        ? `Free stretches of at least ${args.minutes} minutes ${scope}, in ${timeZone}:\n${slots
            .map(
              (slot) =>
                `- ${readableTime(slot.start, timeZone)} to ${readableTime(slot.end, timeZone)} (${isoInZone(slot.start, timeZone)} to ${isoInZone(slot.end, timeZone)})`,
            )
            .join("\n")}`
        : `No free stretch of ${args.minutes} minutes ${scope} between ${readableTime(from, timeZone)} and ${readableTime(to, timeZone)}.`,
    };
  }

  private createEvent(
    tc: ToolContext,
    args: z.infer<typeof schemas.create_event>,
    timeZone: string,
  ): PreparedAction {
    const self = tc.resolved.account.display;
    const window = times(args, timeZone)!;
    const guests = [...new Set(args.guests.map((guest) => guest.toLowerCase()))];
    const effect = calendarEffect("create_event", { before: [], after: guests }, self);
    const notifies = effect === "outward";
    const body: Record<string, unknown> = {
      // From the action's id, so trying again can't make a second event.
      id: eventIdFor(tc.actionId),
      summary: args.title,
      ...(args.location ? { location: args.location } : {}),
      ...(args.description ? { description: args.description } : {}),
      start: window.start,
      end: window.end,
      ...(guests.length ? { attendees: guests.map((email) => ({ email })) } : {}),
      ...(args.reminders_minutes
        ? {
            reminders: {
              useDefault: false,
              overrides: args.reminders_minutes.map((minutes) => ({ method: "popup", minutes })),
            },
          }
        : {}),
      ...(args.add_meet
        ? {
            conferenceData: {
              createRequest: {
                requestId: tc.actionId,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    };
    const preview = eventPreview({
      account: self,
      change: "create",
      event: { summary: args.title, start: window.start, end: window.end, location: args.location },
      guests,
      notifiesGuests: notifies,
      calendar: args.calendar_id,
      timeZone,
    });
    return {
      tool: "calendar.create_event",
      effect,
      request: {
        calendarId: args.calendar_id,
        event: body,
        sendUpdates: notifies ? "all" : "none",
        conferenceDataVersion: args.add_meet ? 1 : 0,
      },
      summary: `Add “${args.title}” on ${whenText(window, timeZone)}${guests.length ? ` with ${guests.length} guest${guests.length === 1 ? "" : "s"}` : ""}`,
      detail: [
        `${args.title}`,
        whenText(window, timeZone),
        ...(guests.length ? [`Guests (they get an email): ${guests.join(", ")}`] : []),
      ].join("\n"),
      preview,
      labels: {
        waiting: `Adding “${args.title}” waits for you`,
        done: `Added “${args.title}” to your calendar`,
        failed: `Couldn't add “${args.title}”`,
      },
    };
  }

  private async updateEvent(
    api: CalendarApi,
    tc: ToolContext,
    args: z.infer<typeof schemas.update_event>,
    timeZone: string,
  ): Promise<PreparedAction> {
    const self = tc.resolved.account.display;
    const event = await api.get<CalendarEvent>(eventPath(args.calendar_id, args.event_id));
    const before = guestEmails(event);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.summary = args.title;
    if (args.location !== undefined) patch.location = args.location;
    if (args.description !== undefined) patch.description = args.description;
    const window = times(args, timeZone);
    if (window) Object.assign(patch, window);
    let after = before;
    if (args.guests || args.add_guests.length || args.remove_guests.length) {
      const removed = new Set(args.remove_guests.map((guest) => guest.toLowerCase()));
      const wanted = [
        ...new Set(
          [...(args.guests ?? before), ...args.add_guests].map((guest) => guest.toLowerCase()),
        ),
      ].filter((guest) => !removed.has(guest));
      const existing = new Map(
        (event.attendees ?? []).map((guest) => [guest.email.toLowerCase(), guest]),
      );
      // Guests who stay keep their answers.
      patch.attendees = [
        ...(event.attendees ?? []).filter((guest) => guest.resource),
        ...wanted.map((email) => existing.get(email) ?? { email }),
      ];
      after = wanted;
    }
    if (Object.keys(patch).length === 0) throw new AccountToolError("Say what to change.");
    const effect = calendarEffect("update_event", { before, after }, self);
    const notifies = effect === "outward";
    const title = (patch.summary as string | undefined) ?? event.summary ?? "(no title)";
    const changed = Object.keys(patch)
      .map((key) => ({ summary: "title", attendees: "guests" })[key] ?? key)
      .join(", ");
    return {
      tool: "calendar.update_event",
      effect,
      request: {
        calendarId: args.calendar_id,
        eventId: event.id,
        etag: event.etag,
        patch,
        sendUpdates: notifies ? "all" : "none",
      },
      summary: `Change ${changed} of “${title}”`,
      detail: `${title}\n${when({ ...event, ...(window ?? {}) } as CalendarEvent, timeZone)}${after.length ? `\nGuests${notifies ? " (they get an email)" : ""}: ${after.join(", ")}` : ""}`,
      preview: eventPreview({
        account: self,
        change: "update",
        event: {
          summary: title,
          start: window?.start ?? event.start,
          end: window?.end ?? event.end,
          location: (patch.location as string | undefined) ?? event.location,
        },
        guests: after,
        notifiesGuests: notifies,
        calendar: args.calendar_id,
        timeZone,
      }),
      labels: {
        waiting: `Change to “${title}” waits for you`,
        done: `Changed “${title}”`,
        failed: `Couldn't change “${title}”`,
      },
    };
  }

  private async deleteEvent(
    api: CalendarApi,
    tc: ToolContext,
    args: z.infer<typeof schemas.delete_event>,
    timeZone: string,
  ): Promise<PreparedAction> {
    const self = tc.resolved.account.display;
    const event = await api.get<CalendarEvent>(eventPath(args.calendar_id, args.event_id));
    const guests = guestEmails(event).filter((guest) => guest.toLowerCase() !== self.toLowerCase());
    const title = event.summary ?? "(no title)";
    return {
      tool: "calendar.delete_event",
      effect: calendarEffect("delete_event", { before: guests, after: [] }, self),
      request: {
        calendarId: args.calendar_id,
        eventId: event.id,
        etag: event.etag,
        sendUpdates: guests.length ? "all" : "none",
      },
      summary: `Delete “${title}” (${when(event, timeZone).split(" (")[0]})`,
      detail: `${title}\n${when(event, timeZone)}${guests.length ? `\nGuests get a cancellation: ${guests.join(", ")}` : ""}`,
      preview: eventPreview({
        account: self,
        change: "delete",
        event,
        guests,
        notifiesGuests: guests.length > 0,
        calendar: args.calendar_id,
        timeZone,
      }),
      labels: {
        waiting: `Deleting “${title}” waits for you`,
        done: `Deleted “${title}”`,
        failed: `Couldn't delete “${title}”`,
      },
    };
  }

  private async respond(
    api: CalendarApi,
    tc: ToolContext,
    args: z.infer<typeof schemas.respond>,
    timeZone: string,
  ): Promise<PreparedAction> {
    const self = tc.resolved.account.display;
    const event = await api.get<CalendarEvent>(eventPath(args.calendar_id, args.event_id));
    if (!event.attendees?.some((guest) => guest.self))
      throw new AccountToolError(
        "The user isn't a guest of this event, so there's nothing to answer.",
      );
    const title = event.summary ?? "(no title)";
    const word = { accepted: "Accept", declined: "Decline", tentative: "Maybe" }[args.response];
    return {
      tool: "calendar.respond",
      effect: calendarEffect("respond", { before: guestEmails(event), after: [] }, self),
      request: {
        calendarId: args.calendar_id,
        eventId: event.id,
        etag: event.etag,
        response: args.response,
        note: args.note ?? null,
      },
      summary: `${word} “${title}”`,
      detail: `${word} “${title}” (${when(event, timeZone)})${args.note ? `\nNote: ${args.note}` : ""}`,
      preview: eventPreview({
        account: self,
        change: "respond",
        event,
        guests: guestEmails(event),
        notifiesGuests: true,
        calendar: args.calendar_id,
        timeZone,
        response: args.response,
      }),
      labels: {
        waiting: `Answer to “${title}” waits for you`,
        done: `Answered “${title}”: ${args.response}`,
        failed: `Couldn't answer “${title}”`,
      },
    };
  }

  /** Runs Calendar actions for the executor. */
  readonly runner: ActionRunner = {
    execute: async (action, tokens) => {
      const api = new CalendarApi(tokens);
      const request = action.request as Record<string, unknown>;
      const calendarId = String(request.calendarId);
      switch (action.tool) {
        case "calendar.create_event": {
          const body = request.event as CalendarEvent;
          try {
            const event = await api.write<CalendarEvent>("POST", eventPath(calendarId), {
              body,
              query: {
                sendUpdates: String(request.sendUpdates),
                conferenceDataVersion: Number(request.conferenceDataVersion ?? 0),
              },
            });
            return created(event);
          } catch (error) {
            // The id is taken: an earlier try made it.
            if (error instanceof ProviderError && error.status === 409)
              return created(await api.get<CalendarEvent>(eventPath(calendarId, body.id)));
            throw error;
          }
        }
        case "calendar.update_event": {
          const event = await api.write<CalendarEvent>(
            "PATCH",
            eventPath(calendarId, String(request.eventId)),
            {
              body: request.patch,
              query: { sendUpdates: String(request.sendUpdates) },
              etag: request.etag as string | undefined,
            },
          );
          return {
            status: "done",
            message: `Changed it (event_id ${event.id}).`,
            result: { eventId: event.id, htmlLink: event.htmlLink },
          };
        }
        case "calendar.delete_event": {
          try {
            await api.write("DELETE", eventPath(calendarId, String(request.eventId)), {
              query: { sendUpdates: String(request.sendUpdates) },
              etag: request.etag as string | undefined,
            });
          } catch (error) {
            if (!(error instanceof ProviderError && error.status === 410)) throw error;
          }
          return { status: "done", message: "Deleted it.", result: {} };
        }
        case "calendar.respond":
          return this.answer(api, action);
        default:
          return { status: "failed", error: `Unknown Calendar action ${action.tool}.` };
      }
    },
    reconcile: async (action, tokens) => {
      const api = new CalendarApi(tokens);
      const request = action.request as Record<string, unknown>;
      const calendarId = String(request.calendarId);
      const eventId =
        action.tool === "calendar.create_event"
          ? String((request.event as CalendarEvent).id)
          : String(request.eventId);
      let event: CalendarEvent | null;
      try {
        event = await api.get<CalendarEvent>(eventPath(calendarId, eventId));
      } catch (error) {
        if (error instanceof ProviderError && (error.status === 404 || error.status === 410))
          event = null;
        else throw error;
      }
      switch (action.tool) {
        case "calendar.create_event":
          // Made with this action's own id, so running it again can't duplicate it.
          return event ? created(event) : "not_done";
        case "calendar.delete_event":
          return !event || event.status === "cancelled"
            ? { status: "done", message: "Deleted it.", result: {} }
            : "not_done";
        case "calendar.update_event": {
          if (!event) return null;
          const patch = request.patch as Record<string, unknown>;
          const applied = Object.entries(patch).every(([key, value]) =>
            key === "attendees"
              ? sameGuests(event.attendees ?? [], value as Attendee[])
              : JSON.stringify(
                  normalizeTime((event as unknown as Record<string, unknown>)[key]),
                ) === JSON.stringify(normalizeTime(value)),
          );
          // Not applied: the etag still guards against overwriting someone else's change.
          return applied
            ? {
                status: "done",
                message: `Changed it (event_id ${event.id}).`,
                result: { eventId: event.id },
              }
            : "not_done";
        }
        case "calendar.respond": {
          const me = event?.attendees?.find((guest) => guest.self);
          return me?.responseStatus === request.response
            ? { status: "done", message: `Answered: ${String(request.response)}.`, result: {} }
            : "not_done";
        }
        default:
          return null;
      }
    },
  };

  /**
   * Answer an invitation. Your answer is what you approved; if the organizer changed the event
   * meanwhile, it's applied to the event as it is now, without touching anything else.
   */
  private async answer(api: CalendarApi, action: ActionRow): Promise<ActionOutcome> {
    const request = action.request as Record<string, unknown>;
    const path = eventPath(String(request.calendarId), String(request.eventId));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const event = await api.get<CalendarEvent>(path);
      const attendees = (event.attendees ?? []).map((guest) =>
        guest.self
          ? {
              ...guest,
              responseStatus: String(request.response),
              ...(request.note ? { comment: String(request.note) } : {}),
            }
          : guest,
      );
      try {
        await api.write("PATCH", path, {
          body: { attendees },
          query: { sendUpdates: "all" },
          etag: event.etag,
        });
        return { status: "done", message: `Answered: ${String(request.response)}.`, result: {} };
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 412) || attempt === 1) throw error;
      }
    }
    return { status: "failed", error: "The event kept changing; try again." };
  }
}

function created(event: CalendarEvent): ActionOutcome {
  const meet =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  return {
    status: "done",
    message: `Added it (event_id ${event.id})${meet ? `, with a video call at ${meet}` : ""}${event.htmlLink ? `. Link: ${event.htmlLink}` : ""}.`,
    result: { eventId: event.id, htmlLink: event.htmlLink, meet },
    providerRef: { eventId: event.id },
  };
}

function start(event: CalendarEvent): number {
  return Date.parse(event.start?.dateTime ?? event.start?.date ?? "") || 0;
}

function whenText(window: { start: EventTime; end: EventTime }, timeZone: string): string {
  return when({ id: "", ...window }, timeZone).split(" (")[0]!;
}

function normalizeTime(value: unknown): unknown {
  if (value && typeof value === "object" && "dateTime" in value) {
    const time = value as EventTime;
    return { dateTime: time.dateTime ? new Date(time.dateTime).toISOString() : undefined };
  }
  return value ?? "";
}

function sameGuests(current: Attendee[], wanted: Attendee[]): boolean {
  const set = (list: Attendee[]) =>
    list
      .map((guest) => guest.email.toLowerCase())
      .sort()
      .join(",");
  return set(current) === set(wanted);
}
