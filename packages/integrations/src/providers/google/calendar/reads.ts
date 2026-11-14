// Calendar's read tools: they answer the teammate directly.
import { outsideData } from "@open-bot/domain";
import { z } from "zod";
import { AccountToolError } from "../../../core/errors";
import { CalendarApi, eventDetails, eventLine, eventPath, type CalendarEvent } from "./api";
import { freeTime, isoInZone, readableTime, type WorkingHours } from "./time";
import type { ToolResult } from "../../../core/adapter";
import { schemas } from "./tools";

const MAX_RESULT_TEXT = 100_000;

export async function listCalendars(api: CalendarApi): Promise<ToolResult> {
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

export async function listEvents(
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

export async function getEvent(
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

export async function findFreeTime(
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

function start(event: CalendarEvent): number {
  return Date.parse(event.start?.dateTime ?? event.start?.date ?? "") || 0;
}
