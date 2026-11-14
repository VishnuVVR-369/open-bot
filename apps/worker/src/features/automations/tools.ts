// Automation tools: schedules, page watches and webhooks, and listing, changing and cancelling
// every automation. Gmail and Calendar triggers are set up in ./account-watch-tools.ts.
import { schedules } from "@open-bot/db";
import { calendarEventFilterSchema, describeInterval } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AccountTools } from "../integrations";
import type { Context } from "../../context";
import { optionalTarget, type TeammateTargets } from "../../core/targets";
import {
  defineTool,
  text,
  toolItem,
  type ToolDefinition,
  type ToolResponse,
} from "../../core/tool";
import { errorMessage } from "../../logger";
import type { RunSession } from "../../runs/session";
import type { ApprovalService } from "../approvals";
import type { ScheduleService } from "./schedules";
import { ACCOUNT_WATCH_TOOLS } from "./account-watch-tools";
import { TriggerError, type TriggerService } from "./triggers";

/** What the automation tools use. */
interface AutomationToolDeps {
  ctx: Pick<Context, "db">;
  schedules: ScheduleService;
  triggers: TriggerService;
  approvals: Pick<ApprovalService, "requestAction">;
  accounts: Pick<AccountTools, "connectionFor">;
  teammateTools: TeammateTargets;
}

const scheduleTaskInput = z.object({
  title: z.string().min(1).max(80),
  teammate_id: optionalTarget,
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
});

const watchPageInput = z.object({
  teammate_id: optionalTarget,
  title: z.string().min(1).max(80),
  url: z.string().describe("The page's absolute http or https URL."),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe("What you should do when it changes. You'll get this with the lines that changed."),
  every_minutes: z.number().int().min(5).max(10080).describe("How often to check.").default(60),
  look_for: z
    .string()
    .max(200)
    .describe(
      "Optional text to wait for, e.g. 'In stock'. Then it fires only when the text appears, not on every change.",
    )
    .optional(),
});

const createWebhookInput = z.object({
  teammate_id: optionalTarget,
  title: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4000).describe("What you should do with each request."),
});

const updateAutomationInput = z.object({
  teammate_id: optionalTarget,
  id: z.string().uuid("No automation with that id."),
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
});

export const AUTOMATION_TOOLS: ToolDefinition<z.ZodObject, AutomationToolDeps>[] = [
  defineTool({
    name: "schedule_task",
    description:
      "Schedule work for yourself or a specified teammate: a recurring routine (cron) or a one-time reminder (at). Each run starts in that teammate's Scheduled chat with the prompt you give here, so write the prompt so it makes sense on its own.",
    input: scheduleTaskInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      scheduleTask(deps, session, callId, args, raw),
  }),
  defineTool({
    name: "watch_page",
    description:
      "Watch a web page for yourself or a specified teammate (teammate_id). Changes start a run in that teammate's Scheduled chat, for example for prices, stock, job boards or status pages. Checks run without a browser session and only see what a signed-out visitor sees. The first check just learns the page.",
    input: watchPageInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) => watchPage(deps, session, callId, args, raw),
  }),
  ...ACCOUNT_WATCH_TOOLS,
  defineTool({
    name: "create_webhook",
    description:
      "Create a webhook URL for yourself or a specified teammate (teammate_id). Calls start a run in that teammate's Scheduled chat with the request it received. Use it to connect services that send webhooks (GitHub, Stripe, Zapier, a form, a script). Returns the URL to give to that service.",
    input: createWebhookInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      createWebhook(deps, session, callId, args, raw),
  }),
  defineTool({
    name: "list_automations",
    description:
      "List your or a specified teammate's schedules, reminders, page watches, webhooks, and Gmail and Calendar triggers, with their ids.",
    input: z.object({
      teammate_id: optionalTarget,
    }),
    helpers: "allowed",
    handle: async ({ session, args }, deps) =>
      text(await listAutomations(deps, (await deps.teammateTools.target(session, args)).id)),
  }),
  defineTool({
    name: "cancel_automation",
    description:
      "Delete a schedule, reminder, page watch, webhook, or Gmail or Calendar trigger by id, from yourself or the teammate specified by teammate_id. The automation must belong to that teammate.",
    input: z.object({
      id: z.string().uuid("No automation with that id."),
      teammate_id: optionalTarget,
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      cancelAutomation(deps, session, callId, args, raw),
  }),
  defineTool({
    name: "update_automation",
    description:
      "Change a schedule, reminder, page watch, webhook, or Gmail or Calendar trigger by id (see list_automations), yours or the teammate's given by teammate_id: pause or resume it, rename it, or change its instructions, timing, page, the text it waits for, its Gmail search, or which events and how early. Leave out what stays the same.",
    input: updateAutomationInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      updateAutomation(deps, session, callId, args, raw),
  }),
];

async function scheduleTask(
  deps: AutomationToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof scheduleTaskInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const target = await deps.teammateTools.setupTarget(
    session,
    callId,
    "schedule_task",
    args,
    ({ teammate }) => `Schedule "${args.title}" for ${teammate}`,
  );
  const schedule = await deps.schedules.create({
    teammateId: target.id,
    title: args.title,
    prompt: args.prompt,
    cron: args.cron ?? null,
    at: args.at ?? null,
    timezone: args.timezone ?? null,
    quiet: args.quiet,
    createdBy: "bot",
    createdByRunId: session.run.id,
  });
  const when = schedule.nextRunAt ? schedule.nextRunAt.toISOString() : "never";
  session.putItem({
    ...toolItem(
      callId,
      "schedule_task",
      target.id === session.teammate.id
        ? `Scheduled “${schedule.title}”`
        : `Scheduled “${schedule.title}” for ${target.name}`,
      raw,
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
    `Scheduled "${schedule.title}" (id ${schedule.id})${target.id === session.teammate.id ? "" : ` for ${target.name}; it runs in their Scheduled chat`}. Next run: ${when} (${schedule.timezone}).`,
  );
}

async function watchPage(
  deps: AutomationToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof watchPageInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const target = await deps.teammateTools.setupTarget(
    session,
    callId,
    "watch_page",
    args,
    ({ teammate }) => `Watch ${args.url} for ${teammate}`,
  );
  let watch;
  try {
    watch = await deps.triggers.create(
      {
        teammateId: target.id,
        kind: "watch",
        title: args.title,
        prompt: args.prompt,
        url: args.url,
        intervalMinutes: args.every_minutes,
        lookFor: args.look_for ?? null,
      },
      { kind: "bot", runId: session.run.id },
    );
  } catch (error) {
    if (error instanceof TriggerError) return text(error.message, false);
    throw error;
  }
  const every = describeInterval(watch.intervalMinutes ?? 60).toLowerCase();
  session.putItem({
    ...toolItem(callId, "watch_page", `Watching “${watch.title}”`, raw, startedAt),
    status: "completed",
    completedAt: session.now(),
    result: `${watch.url}, ${every}${watch.lookFor ? `, waiting for “${watch.lookFor}”` : ""}`,
  });
  return text(
    `Watching ${watch.url} ${every} (id ${watch.id})${target.id === session.teammate.id ? "" : ` for ${target.name}`}.${watch.lookFor ? ` It fires when "${watch.lookFor}" appears.` : " It fires on any change."} ${target.id === session.teammate.id ? "You'll get a run in your Scheduled chat when it fires." : `${target.name} gets a run in their Scheduled chat when it fires.`}`,
  );
}

async function createWebhook(
  deps: AutomationToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof createWebhookInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const target = await deps.teammateTools.setupTarget(
    session,
    callId,
    "create_webhook",
    args,
    ({ teammate }) => `Create the webhook "${args.title}" for ${teammate}`,
  );
  // A webhook is a way in from outside; a run that read your accounts asks before opening one.
  if (session.run.readOutsideData) {
    const decision = await deps.approvals.requestAction(session, {
      title: `Create the webhook “${args.title}”`,
      detail: `${session.teammate.name} read mail, events or pages from your accounts in this task, so it asks before creating a webhook.\n\n${args.prompt}`,
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
        teammateId: target.id,
        kind: "webhook",
        title: args.title,
        prompt: args.prompt,
      },
      { kind: "bot", runId: session.run.id },
    );
  } catch (error) {
    if (error instanceof TriggerError) return text(error.message, false);
    throw error;
  }
  const url = deps.triggers.webhookUrl(hook.token!);
  session.putItem({
    ...toolItem(callId, "create_webhook", `Created the webhook “${hook.title}”`, raw, startedAt),
    status: "completed",
    completedAt: session.now(),
    result: url,
  });
  return text(
    `Created the webhook "${hook.title}" (id ${hook.id})${target.id === session.teammate.id ? "" : ` for ${target.name}`}. URL: ${url}\nIt accepts GET and POST. Each call starts a run in ${target.id === session.teammate.id ? "your" : `${target.name}'s`} Scheduled chat, up to 30 an hour.`,
  );
}

async function listAutomations(deps: AutomationToolDeps, teammateId: string): Promise<string> {
  const [scheduled, triggered] = await Promise.all([
    deps.schedules.describeForTeammate(teammateId),
    deps.triggers.describeForTeammate(teammateId),
  ]);
  return triggered
    ? `${scheduled}\n\nWatches, webhooks, and Gmail and Calendar triggers:\n${triggered}`
    : `${scheduled}\nYou have no page watches, webhooks, or Gmail or Calendar triggers.`;
}

async function cancelAutomation(
  deps: AutomationToolDeps,
  session: RunSession,
  callId: string,
  args: { id: string; teammate_id?: string | undefined },
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const { id } = args;
  const teammateId = (
    await deps.teammateTools.setupTarget(
      session,
      callId,
      "cancel_automation",
      args,
      ({ teammate, automation }) => `Delete ${automation} for ${teammate}`,
    )
  ).id;
  const schedule = await deps.schedules.cancelForTeammate(teammateId, id);
  const trigger = schedule
    ? null
    : (await deps.triggers.forTeammate(teammateId)).find((row) => row.id === id);
  if (trigger) await deps.triggers.remove(trigger.id);
  const title = schedule?.title ?? trigger?.title;
  if (!title) return text(`No automation with id ${id}.`, false);
  session.putItem({
    ...toolItem(callId, "cancel_automation", `Cancelled “${title}”`, raw, session.now()),
    status: "completed",
    completedAt: session.now(),
  });
  return text(`Cancelled "${title}".`);
}

async function updateAutomation(
  deps: AutomationToolDeps,
  session: RunSession,
  callId: string,
  change: z.output<typeof updateAutomationInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const teammateId = (
    await deps.teammateTools.setupTarget(
      session,
      callId,
      "update_automation",
      change,
      ({ teammate, automation }) => `Change ${automation} for ${teammate}`,
    )
  ).id;
  const startedAt = session.now();
  const [schedule] = await deps.ctx.db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, change.id), eq(schedules.teammateId, teammateId)));
  const trigger = schedule
    ? undefined
    : (await deps.triggers.forTeammate(teammateId)).find((row) => row.id === change.id);
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
          teammateId,
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
          teammateId,
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
      raw,
      startedAt,
    ),
    status: "completed",
    completedAt: session.now(),
  });
  return text(`${summary} ${await listAutomations(deps, teammateId)}`);
}
