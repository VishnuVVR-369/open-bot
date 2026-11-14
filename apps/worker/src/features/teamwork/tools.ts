// Teamwork tools: ask a teammate, and hand a request to one in a group chat.
import { runs } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../../context";
import { enqueueRun } from "../../runs/queue";
import type { RunSession } from "../../runs/session";
import { activeTeammates } from "../teammates";
import { mainChat } from "../chat";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolResponse,
  toolItem,
} from "../../core/tool";

interface TeamworkToolDeps {
  ctx: Context;
}

const askTeammateInput = z.object({
  bot: z.string().describe("The teammate's name."),
  question: z
    .string()
    .trim()
    .min(1, "Write the question first.")
    .max(4000)
    .describe("The question, with the context they need to answer it on their own."),
});

const handoffInput = z.object({
  bot: z.string().describe("The teammate's name."),
  message: z.string().min(1).max(4000).describe("What they should do, with any context they need."),
});

export const TEAMWORK_TOOLS: ToolDefinition<z.ZodObject, TeamworkToolDeps>[] = [
  defineTool({
    name: "ask_teammate",
    description:
      "Ask another teammate a question that their job covers, from any chat, without handing over the whole request. They answer in their own chat, and their answer comes back to you here as a new message, so end your turn after asking.",
    input: askTeammateInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) => askTeammate(deps, session, callId, args, raw),
  }),
  defineTool({
    name: "handoff_to_bot",
    description:
      "In a group chat, hand a request to the teammate whose job covers it. They reply in the same chat. You can't hand a request back to a teammate that already handled it in this chain.",
    input: handoffInput,
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => handoff(deps, session, callId, args),
  }),
];

const MAX_HANDOFF_DEPTH = 6;

/** The bots in the chain of handoffs and questions that led to this run, including its own. */
async function chainOf(
  deps: TeamworkToolDeps,
  session: RunSession,
): Promise<{ bots: Set<string>; depth: number }> {
  const chain = new Set<string>([session.bot.id]);
  let parentId = session.run.parentRunId;
  let depth = 0;
  while (parentId && depth < MAX_HANDOFF_DEPTH) {
    const [parent] = await deps.ctx.db
      .select({ botId: runs.teammateId, parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, parentId));
    if (!parent) break;
    chain.add(parent.botId);
    parentId = parent.parentRunId;
    depth += 1;
  }
  return { bots: chain, depth };
}

async function askTeammate(
  deps: TeamworkToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof askTeammateInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const name = args.bot.trim().toLowerCase();
  const { question } = args;
  const team = await activeTeammates(deps.ctx.db);
  const target = team.find((bot) => bot.name.toLowerCase() === name);
  if (!target)
    return text(
      `No teammate named "${args.bot}". Teammates: ${team.map((bot) => bot.name).join(", ")}.`,
      false,
    );
  if (target.id === session.bot.id) return text("You can't ask yourself.", false);
  const { bots: chain, depth } = await chainOf(deps, session);
  if (chain.has(target.id))
    return text(
      `${target.name} is already part of this request. Answer it yourself or ask the user.`,
      false,
    );
  if (depth + 1 >= MAX_HANDOFF_DEPTH)
    return text("This request has gone through too many teammates. Finish it yourself.", false);
  // They answer in their main chat, where you can see what they did.
  await enqueueRun(deps.ctx, {
    chatId: await mainChat(deps.ctx, target.id),
    botId: target.id,
    trigger: "question",
    prompt: `[${session.bot.name} asks you this, for a task the user gave them. Your reply goes back to ${session.bot.name}, so answer it fully and on its own.]\n${question}`,
    parentRunId: session.run.id,
  });
  session.putItem({
    ...toolItem(callId, "ask_teammate", `Asked ${target.name}`, raw, session.now()),
    status: "completed",
    completedAt: session.now(),
    result: question,
  });
  return text(
    `Asked ${target.name}. Their answer comes back to you in this chat as a new message. End your turn now, telling the user you're checking with ${target.name}.`,
  );
}

async function handoff(
  deps: TeamworkToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof handoffInput>,
): Promise<ToolResponse> {
  if (session.chat.kind !== "group") return text("Handoffs only work in group chats.", false);
  const name = args.bot.trim().toLowerCase();
  const message = args.message.trim();
  const members = await activeTeammates(deps.ctx.db, { inChat: session.chat.id });
  const target = members.find((member) => member.name.toLowerCase() === name);
  if (!target) {
    return text(
      `No teammate named "${args.bot}" in this chat. Teammates: ${members.map((m) => m.name).join(", ")}.`,
      false,
    );
  }
  if (target.id === session.bot.id) return text("You can't hand a request to yourself.", false);

  // Walk the chain that led here, so a request is never passed back.
  const { bots: chain, depth } = await chainOf(deps, session);
  if (chain.has(target.id)) {
    return text(
      `${target.name} already handled this request. Finish it yourself or ask the user.`,
      false,
    );
  }
  if (depth + 1 >= MAX_HANDOFF_DEPTH)
    return text("This request has been handed off too many times. Finish it yourself.", false);

  await enqueueRun(deps.ctx, {
    chatId: session.chat.id,
    botId: target.id,
    trigger: "handoff",
    prompt: `[${session.bot.name} handed this to you] ${message}`,
    parentRunId: session.run.id,
  });
  session.putItem({
    id: callId,
    kind: "handoff",
    toBotId: target.id,
    toBotName: target.name,
    message,
    status: "completed",
    startedAt: session.now(),
    completedAt: session.now(),
  });
  return text(
    `Handed to ${target.name}. They'll reply in this chat. Don't repeat their work; end your turn unless you have your own part to finish.`,
  );
}
