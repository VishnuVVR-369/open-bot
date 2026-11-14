// Calendar's tools: the arguments each one takes (zod) and how it is described to Codex.
import { calendarResponseSchema } from "@open-bot/domain";
import { z } from "zod";
import {
  emails as emailsSchema,
  time,
  tool,
  type JsonSchema,
  type NamespaceTool,
} from "../../../core/tool-spec";

const accountArg = z.string().optional();
const calendarArg = z.string().trim().min(1).default("primary");
export const instant = z
  .string()
  .trim()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Use RFC 3339, like 2026-11-06T10:00:00+01:00.",
  );
export const day = z
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

export const schemas = {
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
    response: calendarResponseSchema,
    note: z.string().trim().max(500).optional(),
    account: accountArg,
  }),
};

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

export const CALENDAR_TOOLS: NamespaceTool[] = [
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
      response: { type: "string", enum: [...calendarResponseSchema.options] },
      note: { type: "string" },
    },
    ["event_id", "response"],
  ),
];
