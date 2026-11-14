// Calendar's change tools: each works out a change, frozen for approval, that the runner sends.
import {
  type AccountActionPreview,
  type CalendarResponse,
  type EventChange,
} from "@open-bot/domain";
import { z } from "zod";
import { AccountToolError } from "../../../core/errors";
import {
  CalendarApi,
  eventPath,
  guestEmails,
  when,
  type CalendarEvent,
  type EventTime,
} from "./api";
import { calendarEffect } from "./effects";
import type { PreparedAction, ToolContext } from "../../../core/adapter";
import { day, instant, schemas } from "./tools";

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
  change: EventChange;
  event: Pick<CalendarEvent, "summary" | "start" | "end" | "location">;
  guests: string[];
  notifiesGuests: boolean;
  calendar: string;
  timeZone: string;
  response?: CalendarResponse;
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

export function createEvent(
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

export async function updateEvent(
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

export async function deleteEvent(
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

export async function respond(
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

function whenText(window: { start: EventTime; end: EventTime }, timeZone: string): string {
  return when({ id: "", ...window }, timeZone).split(" (")[0]!;
}
