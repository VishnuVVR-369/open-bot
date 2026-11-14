// The skill tool: save a skill for a teammate or for everyone.
import { z } from "zod";
import { optionalTarget, type TeammateTargets } from "../../core/targets";
import {
  defineTool,
  text,
  toolItem,
  type ToolDefinition,
  type ToolResponse,
} from "../../core/tool";
import type { RunSession } from "../../runs/session";
import { SkillError, type SkillService } from "./service";

/** What the skill tool uses. */
interface SkillToolDeps {
  skills: SkillService;
  botTools: Pick<TeammateTargets, "setupTarget" | "authorize">;
}

const saveSkillInput = z.object({
  bot_id: optionalTarget,
  skill_id: z
    .string()
    .uuid("Use a skill id from get_bot.")
    .describe(
      "Optional existing skill ID from get_bot, to edit it in the same scope. Otherwise create a skill, or update one you previously saved with that name in this scope.",
    )
    .optional(),
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(48)
    .describe("Short kebab-case name, e.g. 'weekly-report'."),
  description: z.string().min(1).max(300).describe("When to use it, in one sentence."),
  instructions: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      "Markdown: the purpose, the inputs it needs, where to get information, the steps, checks before finishing, the output format, and what to do when something fails.",
    ),
  for_everyone: z
    .boolean()
    .describe(
      "True to share it with every teammate; cannot be combined with bot_id. Otherwise save for bot_id or yourself.",
    )
    .default(false),
});

export const SKILL_TOOLS: ToolDefinition<z.ZodObject, SkillToolDeps>[] = [
  defineTool({
    name: "save_skill",
    description:
      "Save a reusable skill for yourself, a specified teammate (bot_id), or everyone (for_everyone): step-by-step instructions for a task. The user can run it with /name. Save when the user asks, or offer after finishing recurring work. The name of a skill you previously saved in this scope updates it; use skill_id from get_bot to edit another existing skill.",
    input: saveSkillInput,
    helpers: "forbidden",
    handle: ({ session, callId, args, raw }, deps) => saveSkill(deps, session, callId, args, raw),
  }),
];

async function saveSkill(
  deps: SkillToolDeps,
  session: RunSession,
  callId: string,
  args: z.output<typeof saveSkillInput>,
  raw: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  const shared = args.for_everyone;
  if (shared && args.bot_id !== undefined)
    return text("Choose bot_id or for_everyone, not both.", false);
  const target = await deps.botTools.setupTarget(
    session,
    callId,
    "save_skill",
    args,
    ({ teammate }) => `Save the /${args.name} skill for ${teammate}`,
  );
  const skillId = args.skill_id;
  if (skillId) {
    const existing = (await deps.skills.forBot(target.id)).find((skill) => skill.id === skillId);
    if (!existing || existing.botId !== (shared ? null : target.id))
      return text(
        "That skill isn't in the selected scope. Get the teammate's skills first.",
        false,
      );
    // Rewriting a skill you didn't write is a change to the user's setup, so it asks like one.
    if (target.id === session.bot.id && existing.createdByBotId !== session.bot.id)
      await deps.botTools.authorize(session, callId, {
        tool: "save_skill",
        args,
        title: `Rewrite the /${existing.name} skill`,
        detail: `${args.description}\n\n${args.instructions}`.trim(),
      });
  }
  let skill;
  try {
    skill = await deps.skills.save(
      {
        name: args.name,
        description: args.description,
        instructions: args.instructions,
        botId: shared ? null : target.id,
      },
      { kind: "bot", botId: session.bot.id },
      skillId,
    );
  } catch (error) {
    if (error instanceof SkillError) return text(error.message, false);
    throw error;
  }
  session.putItem({
    ...toolItem(callId, "save_skill", `Saved the skill /${skill.name}`, raw, startedAt),
    status: "completed",
    completedAt: session.now(),
    result: skill.description,
  });
  return text(
    `Saved /${skill.name}${shared ? " for every teammate" : target.id === session.bot.id ? "" : ` for ${target.name}`}. The user can run it by typing /${skill.name} in a chat.`,
  );
}
