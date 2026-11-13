// Teammate tools: list, read, create and change teammates, their connections, and proposing new
// instructions for yourself. Creating and changing go through BotTools (./changes.ts), which asks.
import { bots } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../../context";
import {
  defineTool,
  text,
  toolItem,
  type ToolCall,
  type ToolDefinition,
  type ToolResponse,
} from "../../core/tool";
import { targetTeammate } from "../../core/targets";
import type { RunSession } from "../../runs/session";
import { createNotification } from "../../services/notifications";
import type { BotTools } from "./changes";
import type { BotService } from "./service";

/** What the teammate tools use. */
interface TeammateToolDeps {
  ctx: Pick<Context, "db" | "pool" | "events">;
  teammates: Pick<BotService, "proposeInstructions">;
  botTools: BotTools;
}

/** A teammate's profile fields, as create_bot and update_bot take them. */
const profileFields = {
  name: z.string().min(1).max(40).optional(),
  role: z.string().min(1).max(80).optional(),
  instructions: z
    .string()
    .max(20000)
    .describe(
      "Their brief, in Markdown: the outcome they own, where their material is, what needs the user's approval, how they work, and how to deliver results.",
    )
    .optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  emoji: z.string().max(8).optional(),
  autonomy: z
    .enum(["risky", "full", "everything"])
    .describe(
      "risky (the default) asks before consequential actions; full works without asking; everything asks before every command. Anything but risky asks the user every time.",
    )
    .optional(),
};

/**
 * Runs a teammate tool through BotTools and answers with its result as JSON. A change also shows
 * in the chat's timeline under `label`.
 */
function teammateTool<Input extends z.ZodObject = z.ZodObject>(
  name: string,
  run: (
    botTools: BotTools,
    call: ToolCall<z.output<Input>>,
  ) => Promise<{ result: unknown; label?: string | undefined }>,
): ToolDefinition<Input, TeammateToolDeps>["handle"] {
  return async (call, deps) => {
    const startedAt = call.session.now();
    const { result, label } = await run(deps.botTools, call);
    if (label)
      call.session.putItem({
        ...toolItem(call.callId, name, label, call.raw, startedAt),
        status: "completed",
        completedAt: call.session.now(),
      });
    return text(JSON.stringify(result));
  };
}

const getTeammateInput = z.object({ bot_id: targetTeammate });

const setConnectionInput = z.object({
  bot_id: targetTeammate,
  connection_id: z.string().uuid("Use a connection id from list_bot_connections."), // vocabulary: allow
  assigned: z.boolean(),
  expected_revision: z.string().min(1).max(128),
});

// The tools that create or change a teammate pass on the arguments as Codex sent them: the domain
// schemas that check them are strict, so a misspelled field is refused, not dropped.
const createTeammateInput = z.object({
  ...profileFields,
  template_id: z.string().optional(),
  starter_ids: z
    .array(z.string())
    .max(20)
    .describe("Starter automations to keep from the template, by id.")
    .optional(),
  skills: z
    .array(
      z.object({
        name: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .max(48),
        description: z.string().max(300),
        instructions: z.string().max(20000),
      }),
    )
    .max(10)
    .describe("Skills it starts with, like save_skill's.")
    .optional(),
  schedules: z
    .array(
      z.object({
        title: z.string().max(80),
        prompt: z.string().max(4000),
        cron: z.string().optional(),
        at: z.string().optional(),
        quiet: z.boolean().optional(),
      }),
    )
    .max(10)
    .describe(
      "Routines (cron) and one-time reminders (at) it starts with, like schedule_task's, in the user's timezone. Each runs in its Scheduled chat.",
    )
    .optional(),
});

const updateTeammateInput = z.object({
  bot_id: targetTeammate,
  expected_revision: z.string().min(1).max(128),
  changes: z.object(profileFields).meta({ minProperties: 1 }),
});

export const TEAMMATE_TOOLS: ToolDefinition<z.ZodObject, TeammateToolDeps>[] = [
  defineTool({
    name: "list_bots",
    description:
      "List the user's teammates (you included) with their ids, names, jobs, autonomy and chat links. Check it before creating a teammate, so you adjust one that already does the job instead of adding a second.",
    input: z.object({}),
    helpers: "allowed",
    handle: teammateTool("list_bots", async (botTools) => ({ result: await botTools.bots.list() })),
  }),
  defineTool({
    name: "get_bot",
    description:
      "Read a teammate's whole setup: profile, instructions, skills, schedules, page watches, webhooks, the connections it can use, and its revision for update_bot.",
    input: getTeammateInput,
    helpers: "allowed",
    handle: teammateTool<typeof getTeammateInput>("get_bot", async (botTools, { args }) => ({
      result: await botTools.bots.get(args.bot_id),
    })),
  }),
  defineTool({
    name: "list_bot_templates",
    description:
      "Discover teammate templates, including their instructions, skills and optional starter automations and IDs.",
    input: z.object({}),
    helpers: "allowed",
    handle: teammateTool("list_bot_templates", async (botTools) => ({
      result: botTools.bots.templates(),
    })),
  }),
  defineTool({
    name: "create_bot",
    description:
      "Create a permanent teammate with its own chat. Give a name and role, or a template_id from list_bot_templates (fields you give override it). Include the skills and schedules it should start with, so the user approves the whole teammate at once. The template's skills come along; its starter automations only with starter_ids. Returns its id and chat link, and anything that couldn't be set up: add those with save_skill or schedule_task and its bot_id, never by creating it again.",
    input: createTeammateInput,
    helpers: "forbidden",
    handle: teammateTool<typeof createTeammateInput>(
      "create_bot",
      async (botTools, { session, callId, raw }) => {
        const result = await botTools.create(session, callId, raw);
        return { result, label: `Created the teammate ${result.name}` };
      },
    ),
  }),
  defineTool({
    name: "update_bot",
    description:
      "Change a teammate's profile or instructions when the user asks. get_bot first, then send only the changed fields and its revision as expected_revision; a stale revision is refused. Changes apply from the teammate's next message, not a reply already under way. For improvements to yourself that the user didn't ask for, use propose_instructions.",
    input: updateTeammateInput,
    helpers: "forbidden",
    handle: teammateTool<typeof updateTeammateInput>(
      "update_bot",
      async (botTools, { session, callId, raw }) => {
        const { result, name } = await botTools.update(session, callId, raw);
        return { result, label: `Updated ${name}'s profile` };
      },
    ),
  }),
  defineTool({
    name: "list_bot_connections",
    description:
      "List the user's connected services (MCP servers) by id, label, whether they're on, which teammates may use them (botIds null: every teammate) and revision. Never includes credentials.",
    input: z.object({}),
    helpers: "allowed",
    handle: teammateTool("list_bot_connections", async (botTools) => ({
      result: await botTools.bots.listConnections(),
    })),
  }),
  defineTool({
    name: "set_bot_connection",
    description:
      "Let a teammate use one of the user's connections, or stop it. Always asks the user. Use the revision from list_bot_connections as expected_revision. It can't add connections or turn one on, and a connection shared with every teammate is limited in Settings by the user. Applies from the teammate's next message.",
    input: setConnectionInput,
    helpers: "forbidden",
    handle: teammateTool<typeof setConnectionInput>(
      "set_bot_connection",
      async (botTools, { session, callId, raw }) => {
        const result = await botTools.setConnection(session, callId, raw);
        return { result, label: "unchanged" in result ? undefined : "Changed a teammate's access" };
      },
    ),
  }),
  defineTool({
    name: "propose_instructions",
    description:
      "Suggest a better version of your own instructions (the job description the user gave you), for the user to accept or dismiss. Use it when you notice a lasting change would help: from the user's feedback and lessons, repeated corrections, or a weekly review. Give the complete new text, not just the change.",
    input: z.object({
      instructions: z
        .string()
        .trim()
        .min(1, "Give the new instructions and the reason.")
        .max(20000, "Keep the instructions under 20,000 characters.")
        .describe("The full new instructions, in the user's voice like the current ones."),
      reason: z
        .string()
        .trim()
        .min(1, "Give the new instructions and the reason.")
        .max(500)
        .describe("Why, in one or two sentences the user can judge quickly."),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) =>
      proposeInstructions(deps, session, callId, args, raw),
  }),
];

async function proposeInstructions(
  deps: TeammateToolDeps,
  session: RunSession,
  callId: string,
  args: { instructions: string; reason: string },
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const { instructions: proposed, reason } = args;
  const [bot] = await deps.ctx.db
    .select({ instructions: bots.instructions })
    .from(bots)
    .where(eq(bots.id, session.bot.id));
  const current = bot?.instructions ?? "";
  if (proposed === current.trim()) return text("That's the same as your instructions now.", false);
  // A newer suggestion replaces one the user hasn't looked at yet.
  await deps.teammates.proposeInstructions({
    teammateId: session.bot.id,
    current,
    proposed,
    reason,
    runId: session.run.id,
  });
  await createNotification(deps.ctx, {
    kind: "bot_message",
    title: `${session.bot.name} suggests new instructions`,
    body: reason,
    botId: session.bot.id,
    chatId: session.chat.id,
    runId: session.run.id,
  });
  session.putItem({
    ...toolItem(callId, "propose_instructions", "Suggested new instructions", raw, session.now()),
    status: "completed",
    completedAt: session.now(),
    result: reason,
  });
  return text(
    "Suggested. The user sees the change on your page and decides; until then your instructions stay as they are.",
  );
}
