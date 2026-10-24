import { z } from "zod";
import { MAX_LESSON_CHARS } from "./bots";
import { MAX_WATCH_MINUTES, MIN_WATCH_MINUTES } from "./triggers";
import { SKILL_NAME_PATTERN } from "./skills";

/**
 * A teammate as a file you can keep or share: its job and how it works, without its chats,
 * memory notes or webhooks (whose URLs are secrets).
 */
export const BUNDLE_FORMAT = "open-bot.teammate";
export const BUNDLE_VERSION = 1;

export const teammateBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT, { error: "This isn't an open-bot teammate file." }),
  version: z.literal(BUNDLE_VERSION, {
    error: "This teammate file is from a newer open-bot. Update open-bot to import it.",
  }),
  teammate: z.object({
    name: z.string().trim().min(1).max(40),
    role: z.string().trim().min(1).max(80),
    instructions: z.string().max(20_000).default(""),
    emoji: z.string().max(16).default(""),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    autonomy: z.enum(["full", "risky", "everything"]).default("risky"),
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
      }),
    )
    .max(50)
    .default([]),
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
        kind: z.enum(["command", "file_change", "action"]),
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
