// watch_gmail and watch_calendar: automations that wake a teammate from the user's own mail or
// calendar, through the account it has.
import {
  calendarEventFilterSchema,
  describeGmailQuery,
  describeLead,
  TRIGGER_CONNECTION_KIND,
} from "@open-bot/domain";
import { AccountToolError } from "@open-bot/integrations/adapters";
import { z } from "zod";
import type { AccountTools } from "../integrations";
import { optionalTarget, type TeammateTargets } from "../../core/targets";
import {
  defineTool,
  text,
  toolItem,
  type ToolDefinition,
  type ToolResponse,
} from "../../core/tool";
import type { RunSession } from "../../runs/session";
import { TriggerError, type TriggerService } from "./triggers";

/** What the account watch tools use. */
interface AccountWatchToolDeps {
  triggers: Pick<TriggerService, "create">;
  accounts: Pick<AccountTools, "connectionFor">;
  botTools: Pick<TeammateTargets, "setupTarget">;
}

export const ACCOUNT_WATCH_TOOLS: ToolDefinition<z.ZodObject, AccountWatchToolDeps>[] = [
  defineTool({
    name: "watch_gmail",
    description:
      "Wake yourself or a specified teammate (bot_id) when new mail arrives in the user's Gmail. Mail matching the search starts a run in that teammate's Scheduled chat with the new messages, checked every 2 minutes; mail the user sends doesn't count. The teammate must have Gmail. Use it for things like 'tell me when the school writes' or 'file every receipt'.",
    input: z.object({
      bot_id: optionalTarget,
      title: z.string().min(1).max(80),
      query: z
        .string()
        .max(500)
        .describe(
          "A Gmail search the new mail must match, like 'from:school.org' or 'subject:invoice has:attachment'. Leave it out for all new mail.",
        )
        .optional(),
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe("What to do with the new mail. You'll get this with the messages."),
      account: z.string().describe("With several Gmail accounts: the address to watch.").optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      watchAccount(deps, session, callId, "watch_gmail", args, raw),
  }),
  defineTool({
    name: "watch_calendar",
    description:
      "Wake yourself or a specified teammate (bot_id) a set time before events on the user's Google Calendar (their primary calendar). Each event starts a run in that teammate's Scheduled chat with the event, once per occurrence, and again if it moves. Cancelled, all-day and declined events don't count. The teammate must have Google Calendar. Use it for things like 'brief me 30 minutes before meetings with guests'.",
    input: z.object({
      bot_id: optionalTarget,
      title: z.string().min(1).max(80),
      lead_minutes: z
        .number()
        .int()
        .min(0)
        .max(10080)
        .describe("How many minutes before each event to wake up. 0 is when it starts.")
        .default(30),
      events: calendarEventFilterSchema
        .describe("guests: only events with other people on them.")
        .default("all"),
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe("What to do before each event. You'll get this with the event."),
      account: z
        .string()
        .describe("With several Google Calendar accounts: the address to watch.")
        .optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      watchAccount(deps, session, callId, "watch_calendar", args, raw),
  }),
];

/** What watch_gmail and watch_calendar take between them; each leaves out the other's fields. */
type WatchAccountArgs = {
  bot_id?: string | undefined;
  title: string;
  prompt: string;
  account?: string | undefined;
  query?: string | undefined;
  events?: z.output<typeof calendarEventFilterSchema> | undefined;
  lead_minutes?: number | undefined;
};

/** watch_gmail and watch_calendar: wake a teammate from the user's own mail or calendar. */
async function watchAccount(
  deps: AccountWatchToolDeps,
  session: RunSession,
  callId: string,
  tool: "watch_gmail" | "watch_calendar",
  args: WatchAccountArgs,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const kind = tool === "watch_gmail" ? "gmail" : "calendar";
  const target = await deps.botTools.setupTarget(session, callId, tool, args, ({ teammate }) =>
    tool === "watch_gmail"
      ? `Wake ${teammate} for new mail: "${args.title}"`
      : `Wake ${teammate} before events: "${args.title}"`,
  );
  let row;
  let display;
  try {
    const connection = await deps.accounts.connectionFor(
      target.id,
      TRIGGER_CONNECTION_KIND[kind],
      args.account,
    );
    display = connection.display;
    row = await deps.triggers.create(
      {
        teammateId: target.id,
        kind,
        title: args.title,
        prompt: args.prompt,
        connectionId: connection.connectionId,
        query: kind === "gmail" ? (args.query ?? null) : (args.events ?? "all"),
        leadMinutes: kind === "calendar" ? (args.lead_minutes ?? 30) : null,
      },
      { kind: "bot", runId: session.run.id },
    );
  } catch (error) {
    if (error instanceof TriggerError || error instanceof AccountToolError)
      return text(
        target.id === session.bot.id
          ? error.message
          : error.message.replaceAll("You don't have", `${target.name} doesn't have`),
        false,
      );
    throw error;
  }
  const what =
    kind === "gmail"
      ? `${describeGmailQuery(row.query)} in ${display}`
      : `${describeLead(row.leadMinutes ?? 30).toLowerCase()} ${row.query === "guests" ? "events with other people" : "every event"} on ${display}'s calendar`;
  session.putItem({
    ...toolItem(
      callId,
      tool,
      kind === "gmail" ? `Watching Gmail: “${row.title}”` : `Watching the calendar: “${row.title}”`,
      raw,
      startedAt,
    ),
    status: "completed",
    completedAt: session.now(),
    result: what,
  });
  const who = target.id === session.bot.id ? "You'll get" : `${target.name} gets`;
  return text(
    `Set up "${row.title}" (id ${row.id})${target.id === session.bot.id ? "" : ` for ${target.name}`}: ${what}. ${who} a run in ${target.id === session.bot.id ? "your" : "their"} Scheduled chat ${kind === "gmail" ? "when such mail arrives, checked every 2 minutes, starting now" : "for each event, once"}. Those runs ask the user before sending anything.`,
  );
}
