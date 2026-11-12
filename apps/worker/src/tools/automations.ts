// Automation tools: schedules, page watches, Gmail and Calendar triggers, and webhooks.
import { schedules } from "@open-bot/db";
import {
  calendarEventFilterSchema,
  describeGmailQuery,
  describeInterval,
  describeLead,
  TRIGGER_CONNECTION_KIND,
} from "@open-bot/domain";
import { AccountToolError } from "@open-bot/integrations/adapters";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { errorMessage } from "../logger";
import type { RunSession } from "../runs/session";
import { TriggerError } from "../services/triggers";
import { optionalTarget } from "./teammates";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolDeps,
  type ToolResponse,
  toolItem,
} from "./define";

export const AUTOMATION_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "schedule_task",
    description:
      "Schedule work for yourself or a specified teammate: a recurring routine (cron) or a one-time reminder (at). Each run starts in that teammate's Scheduled chat with the prompt you give here, so write the prompt so it makes sense on its own.",
    input: z.object({
      title: z.string().min(1).max(80),
      bot_id: optionalTarget,
      prompt: z.string().min(1).max(4000).describe("The instruction you'll receive when it runs."),
      cron: z
        .string()
        .describe("Recurring: a 5-field cron expression, e.g. '0 8 * * 1-5' for weekdays at 8:00.")
        .optional(),
      at: z
        .string()
        .describe("One time: an ISO 8601 date-time, e.g. '2026-10-14T09:00:00'.")
        .optional(),
      timezone: z
        .string()
        .describe("IANA timezone, e.g. 'Europe/Berlin'. Defaults to the user's timezone.")
        .optional(),
      quiet: z
        .boolean()
        .describe(
          "For checks that often find nothing (a daily look for renewals, a weekly inbox sweep): runs with nothing worth telling end with 'Nothing to report.' and don't notify the user.",
        )
        .default(false),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => scheduleTask(deps, session, callId, args),
  }),
  defineTool({
    name: "watch_page",
    description:
      "Watch a web page for yourself or a specified teammate (bot_id). Changes start a run in that teammate's Scheduled chat, for example for prices, stock, job boards or status pages. Checks run without a browser session and only see what a signed-out visitor sees. The first check just learns the page.",
    input: z.object({
      bot_id: optionalTarget,
      title: z.string().min(1).max(80),
      url: z.string().describe("The page's absolute http or https URL."),
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "What you should do when it changes. You'll get this with the lines that changed.",
        ),
      every_minutes: z.number().int().min(5).max(10080).describe("How often to check.").default(60),
      look_for: z
        .string()
        .max(200)
        .describe(
          "Optional text to wait for, e.g. 'In stock'. Then it fires only when the text appears, not on every change.",
        )
        .optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => watchPage(deps, session, callId, args),
  }),
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
    handle: ({ session, callId, args }, deps) =>
      watchAccount(deps, session, callId, "watch_gmail", args),
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
    handle: ({ session, callId, args }, deps) =>
      watchAccount(deps, session, callId, "watch_calendar", args),
  }),
  defineTool({
    name: "create_webhook",
    description:
      "Create a webhook URL for yourself or a specified teammate (bot_id). Calls start a run in that teammate's Scheduled chat with the request it received. Use it to connect services that send webhooks (GitHub, Stripe, Zapier, a form, a script). Returns the URL to give to that service.",
    input: z.object({
      bot_id: optionalTarget,
      title: z.string().min(1).max(80),
      prompt: z.string().min(1).max(4000).describe("What you should do with each request."),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => createWebhook(deps, session, callId, args),
  }),
  defineTool({
    name: "list_automations",
    description:
      "List your or a specified teammate's schedules, reminders, page watches, webhooks, and Gmail and Calendar triggers, with their ids.",
    input: z.object({
      bot_id: optionalTarget,
    }),
    helpers: "allowed",
    handle: async ({ session, args }, deps) =>
      text(await listAutomations(deps, (await deps.botTools.target(session, args)).id)),
  }),
  defineTool({
    name: "cancel_automation",
    description:
      "Delete a schedule, reminder, page watch, webhook, or Gmail or Calendar trigger by id, from yourself or the teammate specified by bot_id. The automation must belong to that teammate.",
    input: z.object({
      id: z.string(),
      bot_id: optionalTarget,
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => cancelAutomation(deps, session, callId, args),
  }),
  defineTool({
    name: "update_automation",
    description:
      "Change a schedule, reminder, page watch, webhook, or Gmail or Calendar trigger by id (see list_automations), yours or the teammate's given by bot_id: pause or resume it, rename it, or change its instructions, timing, page, the text it waits for, its Gmail search, or which events and how early. Leave out what stays the same.",
    input: z.object({
      bot_id: optionalTarget,
      id: z.string(),
      enabled: z.boolean().describe("false pauses it, true resumes it.").optional(),
      title: z.string().min(1).max(80).optional(),
      prompt: z.string().min(1).max(4000).optional(),
      cron: z.string().describe("Schedules: a new 5-field cron expression.").optional(),
      at: z.string().describe("Reminders: a new ISO 8601 date-time.").optional(),
      timezone: z.string().describe("Schedules: a new IANA timezone.").optional(),
      url: z.string().describe("Page watches: a new page to watch.").optional(),
      interval_minutes: z
        .number()
        .int()
        .min(5)
        .max(10080)
        .describe("Page watches: how often to check.")
        .optional(),
      look_for: z
        .string()
        .max(200)
        .describe("Page watches: the text to wait for, or an empty string for any change.")
        .optional(),
      query: z
        .string()
        .max(500)
        .describe("Gmail triggers: a new search, or an empty string for all new mail.")
        .optional(),
      lead_minutes: z
        .number()
        .int()
        .min(0)
        .max(10080)
        .describe("Calendar triggers: how many minutes before each event.")
        .optional(),
      events: calendarEventFilterSchema
        .describe("Calendar triggers: every event, or only ones with other people.")
        .optional(),
      quiet: z
        .boolean()
        .describe("Schedules: only tell the user when there's something worth their attention.")
        .optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => updateAutomation(deps, session, callId, args),
  }),
];

const scheduleArgs = z.object({
  bot_id: z.string().uuid().optional(),
  title: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4000),
  cron: z.string().optional(),
  at: z.string().optional(),
  timezone: z.string().optional(),
  quiet: z.boolean().optional(),
});

const updateArgs = z.object({
  bot_id: z.string().uuid().optional(),
  id: z.string().uuid("No automation with that id."),
  enabled: z.boolean().optional(),
  title: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  cron: z.string().optional(),
  at: z.string().optional(),
  timezone: z.string().optional(),
  url: z.string().optional(),
  interval_minutes: z.number().int().optional(),
  look_for: z.string().max(200).optional(),
  query: z.string().max(500).optional(),
  lead_minutes: z.number().int().optional(),
  events: calendarEventFilterSchema.optional(),
  quiet: z.boolean().optional(),
});

async function scheduleTask(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const parsed = scheduleArgs.safeParse(args);
  if (!parsed.success)
    return text(parsed.error.issues.map((issue) => issue.message).join("; "), false);
  const startedAt = session.now();
  const target = await deps.botTools.setupTarget(session, callId, "schedule_task", args);
  const schedule = await deps.schedules.create({
    botId: target.id,
    title: parsed.data.title,
    prompt: parsed.data.prompt,
    cron: parsed.data.cron ?? null,
    at: parsed.data.at ?? null,
    timezone: parsed.data.timezone ?? null,
    quiet: parsed.data.quiet ?? false,
    createdBy: "bot",
    createdByRunId: session.run.id,
  });
  const when = schedule.nextRunAt ? schedule.nextRunAt.toISOString() : "never";
  session.putItem({
    ...toolItem(
      callId,
      "schedule_task",
      target.id === session.bot.id
        ? `Scheduled “${schedule.title}”`
        : `Scheduled “${schedule.title}” for ${target.name}`,
      args,
      startedAt,
    ),
    status: "completed",
    completedAt: session.now(),
    result:
      schedule.kind === "cron"
        ? `Repeats (${schedule.cron}, ${schedule.timezone})`
        : `Runs once at ${when}`,
  });
  return text(
    `Scheduled "${schedule.title}" (id ${schedule.id})${target.id === session.bot.id ? "" : ` for ${target.name}; it runs in their Scheduled chat`}. Next run: ${when} (${schedule.timezone}).`,
  );
}

async function watchPage(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const target = await deps.botTools.setupTarget(session, callId, "watch_page", args);
  let watch;
  try {
    watch = await deps.triggers.create(
      {
        botId: target.id,
        kind: "watch",
        title: String(args.title ?? ""),
        prompt: String(args.prompt ?? ""),
        url: String(args.url ?? ""),
        intervalMinutes: typeof args.every_minutes === "number" ? args.every_minutes : 60,
        lookFor: typeof args.look_for === "string" ? args.look_for : null,
      },
      { kind: "bot", runId: session.run.id },
    );
  } catch (error) {
    if (error instanceof TriggerError) return text(error.message, false);
    throw error;
  }
  const every = describeInterval(watch.intervalMinutes ?? 60).toLowerCase();
  session.putItem({
    ...toolItem(callId, "watch_page", `Watching “${watch.title}”`, args, startedAt),
    status: "completed",
    completedAt: session.now(),
    result: `${watch.url}, ${every}${watch.lookFor ? `, waiting for “${watch.lookFor}”` : ""}`,
  });
  return text(
    `Watching ${watch.url} ${every} (id ${watch.id})${target.id === session.bot.id ? "" : ` for ${target.name}`}.${watch.lookFor ? ` It fires when "${watch.lookFor}" appears.` : " It fires on any change."} ${target.id === session.bot.id ? "You'll get a run in your Scheduled chat when it fires." : `${target.name} gets a run in their Scheduled chat when it fires.`}`,
  );
}

/** watch_gmail and watch_calendar: wake a teammate from the user's own mail or calendar. */
async function watchAccount(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  tool: "watch_gmail" | "watch_calendar",
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const kind = tool === "watch_gmail" ? "gmail" : "calendar";
  const target = await deps.botTools.setupTarget(session, callId, tool, args);
  let row;
  let display;
  try {
    const connection = await deps.accounts.connectionFor(
      target.id,
      TRIGGER_CONNECTION_KIND[kind],
      typeof args.account === "string" ? args.account : undefined,
    );
    display = connection.display;
    row = await deps.triggers.create(
      {
        botId: target.id,
        kind,
        title: String(args.title ?? ""),
        prompt: String(args.prompt ?? ""),
        connectionId: connection.connectionId,
        query:
          kind === "gmail"
            ? typeof args.query === "string"
              ? args.query
              : null
            : typeof args.events === "string"
              ? args.events
              : "all",
        leadMinutes:
          kind === "calendar"
            ? typeof args.lead_minutes === "number"
              ? args.lead_minutes
              : 30
            : null,
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
      args,
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

async function createWebhook(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const target = await deps.botTools.setupTarget(session, callId, "create_webhook", args);
  // A webhook is a way in from outside; a run that read your accounts asks before opening one.
  if (session.run.readOutsideData) {
    const decision = await deps.approvals.requestAction(session, {
      title: `Create the webhook “${String(args.title ?? "")}”`,
      detail: `${session.bot.name} read mail, events or pages from your accounts in this task, so it asks before creating a webhook.\n\n${String(args.prompt ?? "")}`,
      itemId: `${callId}-approval`,
      askEveryTime: true,
      operation: { tool: "create_webhook", arguments: args },
    });
    if (decision !== "approved")
      return text(
        decision === "denied"
          ? "The user didn't approve the webhook. Don't create it."
          : "It's waiting for the user's approval. End your turn; you'll hear back when they decide.",
        decision === "pending",
      );
  }
  let hook;
  try {
    hook = await deps.triggers.create(
      {
        botId: target.id,
        kind: "webhook",
        title: String(args.title ?? ""),
        prompt: String(args.prompt ?? ""),
      },
      { kind: "bot", runId: session.run.id },
    );
  } catch (error) {
    if (error instanceof TriggerError) return text(error.message, false);
    throw error;
  }
  const url = deps.triggers.webhookUrl(hook.token!);
  session.putItem({
    ...toolItem(callId, "create_webhook", `Created the webhook “${hook.title}”`, args, startedAt),
    status: "completed",
    completedAt: session.now(),
    result: url,
  });
  return text(
    `Created the webhook "${hook.title}" (id ${hook.id})${target.id === session.bot.id ? "" : ` for ${target.name}`}. URL: ${url}\nIt accepts GET and POST. Each call starts a run in ${target.id === session.bot.id ? "your" : `${target.name}'s`} Scheduled chat, up to 30 an hour.`,
  );
}

async function listAutomations(deps: ToolDeps, botId: string): Promise<string> {
  const [scheduled, triggered] = await Promise.all([
    deps.schedules.describeForBot(botId),
    deps.triggers.describeForBot(botId),
  ]);
  return triggered
    ? `${scheduled}\n\nWatches, webhooks, and Gmail and Calendar triggers:\n${triggered}`
    : `${scheduled}\nYou have no page watches, webhooks, or Gmail or Calendar triggers.`;
}

async function cancelAutomation(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const id = String(args.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return text(`No automation with id ${id}.`, false);
  const botId = (await deps.botTools.setupTarget(session, callId, "cancel_automation", args)).id;
  const schedule = await deps.schedules.cancelForBot(botId, id);
  const trigger = schedule
    ? null
    : (await deps.triggers.forBot(botId)).find((row) => row.id === id);
  if (trigger) await deps.triggers.remove(trigger.id);
  const title = schedule?.title ?? trigger?.title;
  if (!title) return text(`No automation with id ${id}.`, false);
  session.putItem({
    ...toolItem(callId, "cancel_automation", `Cancelled “${title}”`, args, session.now()),
    status: "completed",
    completedAt: session.now(),
  });
  return text(`Cancelled "${title}".`);
}

async function updateAutomation(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const parsed = updateArgs.safeParse(args);
  if (!parsed.success)
    return text(parsed.error.issues.map((issue) => issue.message).join("; "), false);
  const change = parsed.data;
  const botId = (await deps.botTools.setupTarget(session, callId, "update_automation", args)).id;
  const startedAt = session.now();
  const [schedule] = await deps.ctx.db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, change.id), eq(schedules.botId, botId)));
  const trigger = schedule
    ? undefined
    : (await deps.triggers.forBot(botId)).find((row) => row.id === change.id);
  if (!schedule && !trigger) return text(`No automation with id ${change.id}.`, false);

  let summary: string;
  try {
    if (schedule) {
      const edits = [
        change.title,
        change.prompt,
        change.cron,
        change.at,
        change.timezone,
        change.quiet,
      ];
      if (edits.some((value) => value !== undefined)) {
        // New timing replaces the old; otherwise the schedule keeps its own.
        const newTiming = change.cron !== undefined || change.at !== undefined;
        const cron = newTiming ? (change.cron ?? null) : schedule.cron;
        const at = newTiming ? (change.at ?? null) : (schedule.runAt?.toISOString() ?? null);
        await deps.schedules.update(schedule.id, {
          botId,
          title: change.title ?? schedule.title,
          prompt: change.prompt ?? schedule.prompt,
          cron,
          at,
          timezone: change.timezone ?? schedule.timezone,
          quiet: change.quiet,
        });
      }
      if (change.enabled !== undefined)
        await deps.schedules.setEnabled(schedule.id, change.enabled);
      summary = `Updated "${change.title ?? schedule.title}".`;
    } else {
      const row = trigger!;
      const edits = [
        change.title,
        change.prompt,
        change.url,
        change.interval_minutes,
        change.look_for,
        change.query,
        change.lead_minutes,
        change.events,
      ];
      if (edits.some((value) => value !== undefined)) {
        await deps.triggers.update(row.id, {
          botId,
          kind: row.kind,
          title: change.title ?? row.title,
          prompt: change.prompt ?? row.prompt,
          url: change.url ?? row.url,
          intervalMinutes: change.interval_minutes ?? row.intervalMinutes,
          lookFor: change.look_for ?? row.lookFor,
          connectionId: row.connectionId,
          query:
            row.kind === "gmail"
              ? (change.query ?? row.query)
              : row.kind === "calendar"
                ? (change.events ?? row.query)
                : null,
          leadMinutes: change.lead_minutes ?? row.leadMinutes,
        });
      }
      if (change.enabled !== undefined) await deps.triggers.setEnabled(row.id, change.enabled);
      summary = `Updated "${change.title ?? row.title}".`;
    }
  } catch (error) {
    return text(errorMessage(error), false);
  }
  const title = change.title ?? schedule?.title ?? trigger!.title;
  session.putItem({
    ...toolItem(
      callId,
      "update_automation",
      change.enabled === false
        ? `Paused “${title}”`
        : change.enabled === true
          ? `Resumed “${title}”`
          : `Updated “${title}”`,
      args,
      startedAt,
    ),
    status: "completed",
    completedAt: session.now(),
  });
  return text(`${summary} ${await listAutomations(deps, botId)}`);
}
