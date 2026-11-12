// The swarm tool: split a job into parts that helpers work on at once.
import { MAX_SWARM_TASKS } from "@open-bot/domain";

import { z } from "zod";
import type { RunSession } from "../runs/session";
import { SwarmError } from "../services/swarms";
import { defineTool, text, type AnyTool, type ToolDeps, type ToolResponse } from "./define";

const startSwarmInput = z.object({
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
    .min(2, "A swarm needs at least 2 parts.")
    .max(MAX_SWARM_TASKS, `A swarm can have up to ${MAX_SWARM_TASKS} parts.`),
});

export const SWARM_TOOLS: AnyTool[] = [
  defineTool({
    name: "start_swarm",
    description: `Split a big job into parts that helpers work on at the same time, each with its own screen and browser: comparing many options, researching several vendors, checking a list of sites. Each helper is you, working on one part. Use it when the parts are independent and each takes real work; not for quick lookups. Up to ${MAX_SWARM_TASKS} parts. End your turn after starting it: you get every helper's result in one message, then merge them.`,
    input: startSwarmInput,
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => startSwarm(deps, session, callId, args),
  }),
];

async function startSwarm(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof startSwarmInput>,
): Promise<ToolResponse> {
  try {
    const { tasks } = await deps.swarms.start(session, { ...args, itemId: callId });
    return text(
      `Started ${tasks.length} helpers, each on its own screen. End your turn now and tell the user what they're doing; you'll get all their results in one message.`,
    );
  } catch (error) {
    if (error instanceof SwarmError) return text(error.message, false);
    throw error;
  }
}
