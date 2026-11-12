// Task tools: the team's board.
import { TASK_STATUSES } from "@open-bot/domain";
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { activeTeammates } from "../services/bots";
import { TaskError } from "../services/tasks";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolDeps,
  type ToolResponse,
  toolItem,
} from "./define";

export const TASK_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "list_tasks",
    description:
      "Read the team's task board: open tasks with their ids, owners and due dates, and what was done recently.",
    input: z.object({}),
    helpers: "allowed",
    handle: async ({ session }, deps) => text(await deps.tasks.describe(session.bot.id)),
  }),
  defineTool({
    name: "add_task",
    description:
      "Add a task to the team's board, which the user sees. Use it to break a bigger goal into steps with owners, or to note follow-ups. With start, the owner is asked to work on it right away.",
    input: z.object({
      title: z.string().min(1).max(200),
      notes: z
        .string()
        .max(8000)
        .describe("What done looks like, and any context the owner needs.")
        .optional(),
      owner: z
        .string()
        .describe("The teammate who should do it (their name, or 'me'). Leave out for the user.")
        .optional(),
      due: z.string().describe("The day it's due, as YYYY-MM-DD.").optional(),
      start: z
        .boolean()
        .describe("Ask the owner to start now. Only for tasks another teammate owns.")
        .optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => addTask(deps, session, callId, args),
  }),
  defineTool({
    name: "update_task",
    description:
      "Change a task on the board by id: move it to todo, doing or done, reassign it, or edit it. Mark your tasks done when you finish them.",
    input: z.object({
      id: z.string(),
      status: z.enum(TASK_STATUSES).optional(),
      title: z.string().min(1).max(200).optional(),
      notes: z.string().max(8000).optional(),
      owner: z
        .string()
        .describe("A teammate's name, 'me', or an empty string for nobody.")
        .optional(),
      due: z.string().describe("YYYY-MM-DD, or an empty string for no due date.").optional(),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => updateTask(deps, session, callId, args),
  }),
];

/** A teammate by name ("me" is the caller), or null for nobody; undefined when left out. */
async function ownerFrom(
  deps: ToolDeps,
  session: RunSession,
  value: unknown,
): Promise<{ id: string | null; name: string | null } | undefined> {
  if (value === undefined) return undefined;
  const name = String(value).trim();
  if (!name) return { id: null, name: null };
  if (name.toLowerCase() === "me") return { id: session.bot.id, name: session.bot.name };
  const team = await activeTeammates(deps.ctx.db);
  const bot = team.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!bot)
    throw new TaskError(
      `No teammate named "${name}". Teammates: ${team.map((entry) => entry.name).join(", ")}.`,
    );
  return bot;
}

async function addTask(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  try {
    const owner = await ownerFrom(deps, session, args.owner);
    let task = await deps.tasks.create({
      title: String(args.title ?? ""),
      notes: typeof args.notes === "string" ? args.notes : "",
      ownerBotId: owner?.id ?? null,
      dueOn: typeof args.due === "string" ? args.due : null,
      createdBy: "bot",
      createdByBotId: session.bot.id,
    });
    const start = args.start === true && owner?.id && owner.id !== session.bot.id;
    if (start)
      task = await deps.tasks.start(task.id, {
        botName: session.bot.name,
        runId: session.run.id,
      });
    session.putItem({
      ...toolItem(callId, "add_task", `Added “${task.title}” to the board`, args, startedAt),
      status: "completed",
      completedAt: session.now(),
      result: owner?.name ? `${start ? "Started by" : "For"} ${owner.name}` : undefined,
    });
    return text(
      `Added "${task.title}" (id ${task.id})${owner?.name ? ` for ${owner.name}` : ""}.${start ? ` ${owner!.name} was asked to start on it.` : ""}`,
    );
  } catch (error) {
    if (error instanceof TaskError) return text(error.message, false);
    throw error;
  }
}

async function updateTask(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const status = args.status;
  if (status !== undefined && status !== "todo" && status !== "doing" && status !== "done")
    return text("Status is todo, doing or done.", false);
  try {
    const owner = await ownerFrom(deps, session, args.owner);
    const task = await deps.tasks.update(String(args.id ?? ""), {
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
      ...(status ? { status } : {}),
      ...(owner !== undefined ? { ownerBotId: owner.id } : {}),
      ...(typeof args.due === "string" ? { dueOn: args.due || null } : {}),
    });
    session.putItem({
      ...toolItem(
        callId,
        "update_task",
        status === "done" ? `Finished “${task.title}”` : `Updated “${task.title}”`,
        args,
        startedAt,
      ),
      status: "completed",
      completedAt: session.now(),
    });
    return text(`Updated "${task.title}": ${task.status}.`);
  } catch (error) {
    if (error instanceof TaskError) return text(error.message, false);
    throw error;
  }
}
