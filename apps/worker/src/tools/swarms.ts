// The swarm tool: split a job into parts that helpers work on at once.
import { MAX_SWARM_TASKS } from "@open-bot/domain";

import { z } from "zod";
import type { RunSession } from "../runs/session";
import { SwarmError } from "../services/swarms";
import { defineTool, text, type ToolDefinition, type ToolDeps, type ToolResponse } from "./define";

export const SWARM_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "start_swarm",
    description: `Split a big job into parts that helpers work on at the same time, each with its own screen and browser: comparing many options, researching several vendors, checking a list of sites. Each helper is you, working on one part. Use it when the parts are independent and each takes real work; not for quick lookups. Up to ${MAX_SWARM_TASKS} parts. End your turn after starting it: you get every helper's result in one message, then merge them.`,
    input: z.object({
      title: z
        .string()
        .min(1)
        .max(120)
        .describe("The whole job, e.g. 'Compare 2-bedroom flats in Lisbon'."),
      tasks: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            instructions: z
              .string()
              .min(1)
              .max(8000)
              .describe(
                "Everything the helper needs on its own: what to do, where, and what to report back, in the same format for every part.",
              ),
          }),
        )
        .min(2)
        .max(MAX_SWARM_TASKS),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => startSwarm(deps, session, callId, args),
  }),
];

const swarmArgs = z.object({
  title: z.string().min(1).max(120),
  tasks: z
    .array(
      z.object({ title: z.string().min(1).max(120), instructions: z.string().min(1).max(8000) }),
    )
    .min(2, "A swarm needs at least 2 parts.")
    .max(MAX_SWARM_TASKS, `A swarm can have up to ${MAX_SWARM_TASKS} parts.`),
});

async function startSwarm(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const parsed = swarmArgs.safeParse(args);
  if (!parsed.success)
    return text(parsed.error.issues.map((issue) => issue.message).join("; "), false);
  try {
    const { tasks } = await deps.swarms.start(session, { ...parsed.data, itemId: callId });
    return text(
      `Started ${tasks.length} helpers, each on its own screen. End your turn now and tell the user what they're doing; you'll get all their results in one message.`,
    );
  } catch (error) {
    if (error instanceof SwarmError) return text(error.message, false);
    throw error;
  }
}
