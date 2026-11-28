import { ruleKindSchema } from "../approvals/rules";
import { z } from "zod";
import { teammateProfileSchema } from "./management";
import { lastGlyph, MAX_LESSON_CHARS } from "./profile";
import { MAX_WATCH_MINUTES, MIN_WATCH_MINUTES } from "../automations/triggers";
import { SKILL_NAME_PATTERN } from "../skills/skills";
import { DAILY_CHECK_IN } from "./templates";

/**
 * A teammate as a file you can keep or share: its job and how it works, without its chats,
 * memory notes or webhooks (whose URLs are secrets).
 */
export const BUNDLE_FORMAT = "open-bot.teammate";
export const BUNDLE_VERSION = 1;

/**
 * A file from before check-ins were marked says nothing about them: its check-in is its first quiet
 * routine with the check-in's name, as open-bot found it then.
 */
function markOldCheckIn<T extends { title: string; quiet: boolean; checkIn?: boolean }>(
  routines: T[],
): T[] {
  if (routines.some((routine) => routine.checkIn !== undefined)) return routines;
  const old = routines.findIndex(
    (routine) => routine.title === DAILY_CHECK_IN.title && routine.quiet,
  );
  return routines.map((routine, index) =>
    index === old ? { ...routine, checkIn: true } : routine,
  );
}

export const teammateBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT, { error: "This isn't an open-bot teammate file." }),
  version: z.literal(BUNDLE_VERSION, {
    error: "This teammate file is from a newer open-bot. Update open-bot to import it.",
  }),
  // The profile's own rules, so an imported teammate can always be saved from the form.
  teammate: teammateProfileSchema.extend({
    instructions: teammateProfileSchema.shape.instructions.default(""),
    // Before one glyph was the rule, any 8 code units were saved ("🤖✨", "AB"), and files from then
    // still import: the last glyph is kept, so the teammate can be saved from the form.
    emoji: z
      .string()
      .max(64, "Pick a single emoji.")
      .transform((emoji) => lastGlyph(emoji.trim()))
      .default(""),
    color: teammateProfileSchema.shape.color.optional(),
    autonomy: teammateProfileSchema.shape.autonomy.default("risky"),
  }),
  skills: z
    .array(
      z.object({
        name: z.string().min(2).max(48).regex(SKILL_NAME_PATTERN),
        description: z.string().trim().min(1).max(300),
        instructions: z.string().trim().min(1).max(20_000),
      }),
    )
    .max(100)
    .default([]),
  routines: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        prompt: z.string().trim().min(1).max(4000),
        cron: z.string().min(9).max(120),
        /** Only tells you when there's news. */
        quiet: z.boolean().default(false),
        /** The teammate's daily check-in (one at most). */
        checkIn: z.boolean().optional(),
      }),
    )
    .max(50)
    .default([])
    .transform(markOldCheckIn),
  watches: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        prompt: z.string().trim().min(1).max(4000),
        url: z.string().url().max(2000),
        intervalMinutes: z.number().int().min(MIN_WATCH_MINUTES).max(MAX_WATCH_MINUTES),
        lookFor: z.string().max(200).nullable().default(null),
      }),
    )
    .max(50)
    .default([]),
  allowed: z
    .array(
      z.object({
        kind: ruleKindSchema,
        pattern: z.string().max(500),
      }),
    )
    .max(200)
    .default([]),
  lessons: z.array(z.string().trim().min(1).max(MAX_LESSON_CHARS)).max(200).default([]),
});

export type TeammateBundle = z.infer<typeof teammateBundleSchema>;

/** The file name a teammate exports to, like `iris.openbot.json`. */
export function bundleFileName(slug: string): string {
  return `${slug || "teammate"}.openbot.json`;
}
