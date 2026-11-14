// Runs approved Calendar changes for the executor, and finds out whether an interrupted one happened.
import { ProviderError } from "../../../core/http";
import { CalendarApi, eventPath, type Attendee, type CalendarEvent, type EventTime } from "./api";
import type {
  ActionOutcome,
  ActionRow,
  ActionRunner,
  IntegrationHost,
} from "../../../core/adapter";

/** Runs Calendar actions for the executor. */
export function calendarRunner(host: IntegrationHost): ActionRunner {
  return {
    execute: async (action, tokens) => {
      const api = new CalendarApi(tokens, host.endpoints);
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
          return answer(api, action);
        default:
          return { status: "failed", error: `Unknown Calendar action ${action.tool}.` };
      }
    },
    reconcile: async (action, tokens) => {
      const api = new CalendarApi(tokens, host.endpoints);
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
}

/**
 * Answer an invitation. Your answer is what you approved; if the organizer changed the event
 * meanwhile, it's applied to the event as it is now, without touching anything else.
 */
async function answer(api: CalendarApi, action: ActionRow): Promise<ActionOutcome> {
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
