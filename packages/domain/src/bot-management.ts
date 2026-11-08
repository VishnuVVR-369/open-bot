import { z } from "zod";
import { BOT_COLORS } from "./bots";
import { skillInputSchema } from "./skills";
import { pickStarters, TEAMMATE_TEMPLATES, templateSkills } from "./templates";

/** A teammate's profile: the same validation for the web app and the teammates' tools. */
export const botProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your teammate a name.")
    .max(40, "Keep the name under 40 characters."),
  role: z.string().trim().min(1, "Describe their job in a few words.").max(80),
  instructions: z.string().max(20_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  emoji: z.string().max(8),
  autonomy: z.enum(["full", "risky", "everything"]),
});

export type BotProfile = z.infer<typeof botProfileSchema>;

/** Only what changes; nothing is filled in with a default. */
export const botProfileChangesSchema = botProfileSchema
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "Give at least one field to change.");

/** A skill a new teammate starts with. */
export const newBotSkillSchema = skillInputSchema.omit({ botId: true }).strict();

/** A routine or reminder a new teammate starts with, like schedule_task's. */
export const newBotScheduleSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(4000),
    cron: z.string().min(1).optional(),
    at: z.string().min(1).optional(),
    quiet: z.boolean().optional(),
  })
  .strict()
  .refine((schedule) => Boolean(schedule.cron) !== Boolean(schedule.at), {
    message: "Give each schedule exactly one of cron (recurring) or at (one time).",
  });

export const MAX_NEW_BOT_SETUP = 10;

/**
 * A new teammate: a template and/or profile fields (fields override the template), plus the
 * template starters to keep and any skills and schedules of its own.
 */
export const createBotSchema = botProfileSchema
  .partial()
  .extend({
    template_id: z.string().min(1).optional(),
    starter_ids: z.array(z.string()).max(20).default([]),
    skills: z.array(newBotSkillSchema).max(MAX_NEW_BOT_SETUP).default([]),
    schedules: z.array(newBotScheduleSchema).max(MAX_NEW_BOT_SETUP).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === input.template_id);
    if (input.template_id && !template)
      ctx.addIssue({
        code: "custom",
        path: ["template_id"],
        message: "Unknown teammate template. List the templates first.",
      });
    if (input.starter_ids.some((id) => !template?.starters.some((starter) => starter.id === id)))
      ctx.addIssue({
        code: "custom",
        path: ["starter_ids"],
        message: "Choose starter ids from the selected template.",
      });
    const names = input.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", path: ["skills"], message: "Give each skill its own name." });
  });

export type CreateBotInput = z.input<typeof createBotSchema>;

export const updateBotSchema = z
  .object({
    bot_id: z.string().uuid(),
    expected_revision: z.string().min(1).max(128),
    changes: botProfileChangesSchema,
  })
  .strict();

/** A new teammate, and anything it should have started with but didn't get. */
export interface CreatedBot {
  botId: string;
  name: string;
  chatId: string;
  chatPath: string;
  revision: string;
  /** How many skills and schedules it started with. */
  skills: number;
  schedules: number;
  failed: { kind: "skill" | "schedule"; name: string; error: string }[];
  /** False when the computer was away; its workspace is written before its first run instead. */
  workspaceSynced: boolean;
}

/** Everything a new teammate starts with, resolved from its template and the request. */
export interface BotCreationPlan {
  profile: BotProfile;
  templateId: string | null;
  skills: z.infer<typeof newBotSkillSchema>[];
  schedules: {
    title: string;
    prompt: string;
    cron: string | null;
    at: string | null;
    quiet: boolean;
  }[];
}

/** `color` is used when neither the request nor its template picks one. */
export function botCreation(input: CreateBotInput, color: string = BOT_COLORS[0]): BotCreationPlan {
  const parsed = createBotSchema.parse(input);
  const { template_id, starter_ids, skills, schedules, ...overrides } = parsed;
  const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === template_id);
  // A template never grants more autonomy than "ask before risky actions" on its own.
  const profile = botProfileSchema.parse({
    name: template?.name,
    role: template?.role,
    instructions: template?.instructions ?? "",
    color,
    emoji: template?.emoji ?? "",
    autonomy: "risky",
    ...overrides,
  });
  // The request's own skills replace a template skill with the same name.
  const own = new Set(skills.map((skill) => skill.name));
  return {
    profile,
    templateId: template_id ?? null,
    skills: [
      ...templateSkills(template_id ?? null).filter((skill) => !own.has(skill.name)),
      ...skills,
    ],
    schedules: [
      ...pickStarters(template_id ?? null, [...new Set(starter_ids)]).map((starter) => ({
        title: starter.title,
        prompt: starter.prompt,
        cron: starter.cron,
        at: null,
        quiet: starter.quiet ?? false,
      })),
      ...schedules.map((schedule) => ({
        title: schedule.title,
        prompt: schedule.prompt,
        cron: schedule.cron ?? null,
        at: schedule.at ?? null,
        quiet: schedule.quiet ?? false,
      })),
    ],
  };
}
