import { ownerTimeZone } from "@open-bot/db";
import { AccountToolError } from "../../../core/errors";
import { ProviderError, type TokenSource } from "../../../core/http";
import { CalendarApi, calendarProblem } from "./api";
import { namespace } from "../../../core/tool-spec";
import type {
  ActionRunner,
  IntegrationAdapter,
  ToolContext,
  ResolvedConnection,
  IntegrationHost,
  ToolResult,
} from "../../../core/adapter";
import { findFreeTime, getEvent, listCalendars, listEvents } from "./reads";
import { calendarRunner } from "./runner";
import { CALENDAR_TOOLS, schemas } from "./tools";
import { createEvent, deleteEvent, respond, updateEvent } from "./writes";

/** Google Calendar for teammates. */
export class CalendarTools implements IntegrationAdapter {
  static readonly spec = namespace(
    "google_calendar",
    "The user's Google Calendar: read events, find free time, and add or change events. Anything that emails guests asks the user first.",
    CALENDAR_TOOLS,
  );
  readonly kind = "google_calendar" as const;
  readonly runner: ActionRunner;

  constructor(private readonly host: IntegrationHost) {
    this.runner = calendarRunner(host);
  }

  problem(error: ProviderError): string {
    return calendarProblem(error);
  }

  /** A cheap call that proves the connection works, for Settings' Test. */
  async probe(_resolved: ResolvedConnection, tokens: TokenSource): Promise<string> {
    const { items = [] } = await new CalendarApi(tokens, this.host.endpoints).get<{
      items?: unknown[];
    }>("/users/me/calendarList", {
      maxResults: 250,
    });
    return `${items.length} calendar${items.length === 1 ? "" : "s"}`;
  }

  async call(tool: string, tc: ToolContext): Promise<ToolResult> {
    const api = new CalendarApi(tc.tokens, this.host.endpoints);
    const timeZone = await ownerTimeZone(this.host.db);
    switch (tool) {
      case "list_calendars":
        return listCalendars(api);
      case "list_events":
        return listEvents(api, schemas.list_events.parse(tc.args), timeZone);
      case "get_event":
        return getEvent(api, schemas.get_event.parse(tc.args), timeZone);
      case "find_free_time":
        return findFreeTime(api, schemas.find_free_time.parse(tc.args), timeZone);
      case "create_event":
        return {
          type: "action",
          action: createEvent(tc, schemas.create_event.parse(tc.args), timeZone),
        };
      case "update_event":
        return {
          type: "action",
          action: await updateEvent(api, tc, schemas.update_event.parse(tc.args), timeZone),
        };
      case "delete_event":
        return {
          type: "action",
          action: await deleteEvent(api, tc, schemas.delete_event.parse(tc.args), timeZone),
        };
      case "respond":
        return {
          type: "action",
          action: await respond(api, tc, schemas.respond.parse(tc.args), timeZone),
        };
      default:
        throw new AccountToolError(`Google Calendar has no tool ${tool}.`);
    }
  }
}
