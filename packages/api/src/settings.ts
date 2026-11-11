import { z } from "zod";

/** What Settings shows that isn't a feature of its own. */

/** What every teammate knows about you. */
export const profileViewSchema = z.object({
  aboutMe: z.string(),
  updatedAt: z.string().nullable(),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

/** The API key fallback. */
export const modelAccessViewSchema = z.object({
  keyHint: z.string().nullable(),
  capMicros: z.number(),
  spendMicros: z.number(),
  planLimitedUntil: z.string().nullable(),
});
export type ModelAccessView = z.infer<typeof modelAccessViewSchema>;

/** One teammate's tokens this month; `botId` is null for work no teammate did. */
export const usageViewSchema = z.object({
  botId: z.string().nullable(),
  runs: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
});
export type UsageView = z.infer<typeof usageViewSchema>;

/** The most the API key may spend in a month, in dollars. */
export const MAX_MONTHLY_CAP_DOLLARS = 10_000;

export const monthlyCapInputSchema = z.object({
  dollars: z
    .number({ error: "Give the cap in dollars, like 50." })
    .min(0, "The cap can't be negative.")
    .max(MAX_MONTHLY_CAP_DOLLARS, "Keep the cap at $10,000 or less."),
});

export const apiKeyInputSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .max(500, "That doesn't look like an OpenAI API key. It starts with sk-.")
    .regex(
      /^sk-[A-Za-z0-9_-]{20,}$/,
      "That doesn't look like an OpenAI API key. It starts with sk-.",
    ),
});
