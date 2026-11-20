import { z } from "zod";
import { autonomySchema, TEAMMATE_COLORS } from "./profile";
import { skillInputSchema } from "../skills/skills";
import { pickStarters, TEAMMATE_TEMPLATES, templateSkills } from "./templates";

/** A teammate's profile: the same validation for the web app and the teammates' tools. */
export const teammateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your teammate a name.")
    .max(40, "Keep the name under 40 characters."),
  role: z.string().trim().min(1, "Describe their job in a few words.").max(80),
  instructions: z.string().max(20_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  emoji: z.string().max(8),
  autonomy: autonomySchema,
});

export type TeammateProfile = z.infer<typeof teammateProfileSchema>;

/** Only what changes; nothing is filled in with a default. */
export const teammateProfileChangesSchema = teammateProfileSchema
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "Give at least one field to change.");

/** A skill a new teammate starts with. */
export const newTeammateSkillSchema = skillInputSchema.omit({ teammateId: true }).strict();

/** A routine or reminder a new teammate starts with, like schedule_task's. */
export const newTeammateScheduleSchema = z
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

export const MAX_NEW_TEAMMATE_SETUP = 10;

/**
 * A new teammate: a template and/or profile fields (fields override the template), plus the
 * template starters to keep and any skills and schedules of its own.
 */
export const createTeammateSchema = teammateProfileSchema
  .partial()
  .extend({
    template_id: z.string().min(1).optional(),
    starter_ids: z.array(z.string()).max(20).default([]),
    skills: z.array(newTeammateSkillSchema).max(MAX_NEW_TEAMMATE_SETUP).default([]),
    schedules: z.array(newTeammateScheduleSchema).max(MAX_NEW_TEAMMATE_SETUP).default([]),
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

export type CreateTeammateInput = z.input<typeof createTeammateSchema>;

export const updateTeammateSchema = z
  .object({
    bot_id: z.string().uuid(),
    expected_revision: z.string().min(1).max(128),
    changes: teammateProfileChangesSchema,
  })
  .strict();

/** A new teammate, and anything it should have started with but didn't get. */
/** What a new teammate starts with besides its profile, which can fail one by one. */
export const teammateSetupKindSchema = z.enum(["skill", "schedule"]);
export type TeammateSetupKind = z.infer<typeof teammateSetupKindSchema>;

export const createdTeammateSchema = z.object({
  teammateId: z.string(),
  name: z.string(),
  chatId: z.string(),
  chatPath: z.string(),
  revision: z.string(),
  /** How many skills and schedules it started with. */
  skills: z.number().int(),
  schedules: z.number().int(),
  failed: z.array(z.object({ kind: teammateSetupKindSchema, name: z.string(), error: z.string() })),
  /** False when the computer was away; its workspace is written before its first run instead. */
  workspaceSynced: z.boolean(),
});
export type CreatedTeammate = z.infer<typeof createdTeammateSchema>;

/** A teammate after an edit, with the revision to send with the next one. */
export const updatedTeammateSchema = z.object({
  teammateId: z.string(),
  revision: z.string(),
  workspaceSynced: z.boolean(),
});
export type UpdatedTeammate = z.infer<typeof updatedTeammateSchema>;

/** Everything a new teammate starts with, resolved from its template and the request. */
export interface TeammateCreationPlan {
  profile: TeammateProfile;
  templateId: string | null;
  skills: z.infer<typeof newTeammateSkillSchema>[];
  schedules: {
    title: string;
    prompt: string;
    cron: string | null;
    at: string | null;
    quiet: boolean;
  }[];
}

/** `color` is used when neither the request nor its template picks one. */
export function teammateCreation(
  input: CreateTeammateInput,
  color: string = TEAMMATE_COLORS[0],
): TeammateCreationPlan {
  const parsed = createTeammateSchema.parse(input);
  const { template_id, starter_ids, skills, schedules, ...overrides } = parsed;
  const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === template_id);
  // A template never grants more autonomy than "ask before risky actions" on its own.
  const profile = teammateProfileSchema.parse({
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
