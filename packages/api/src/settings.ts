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
