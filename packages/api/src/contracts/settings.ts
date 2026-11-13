import { chatgptAuthSourceSchema } from "@open-bot/domain";
import { z } from "zod";
import { base, ok } from "../base";
import {
  apiKeyInputSchema,
  modelAccessViewSchema,
  monthlyCapInputSchema,
  profileViewSchema,
  usageViewSchema,
} from "../settings";
import { codexRateLimitsSchema, codexStatusSchema } from "../worker/views";

export const profileContract = {
  /** What every teammate knows about you. */
  get: base.output(profileViewSchema),
};

export const chatgptContract = {
  /** Sign in with a device code, or with the login of the Mac running the stack. */
  setAuthSource: base
    .input(z.object({ source: chatgptAuthSourceSchema }))
    .output(codexStatusSchema),
  /** Start a device-code sign-in: open the URL and enter the code. */
  startLogin: base.output(z.object({ verificationUrl: z.string(), userCode: z.string() })),
  signOut: base.output(ok),
};

export const settingsContract = {
  /** The API key fallback and what it spent this month. */
  modelAccess: base.output(modelAccessViewSchema),
  /** Tokens each teammate used this month. */
  usage: base.output(z.array(usageViewSchema)),
  /** ChatGPT's usage limits as last read. */
  rateLimits: base.output(codexRateLimitsSchema.shape.rateLimits),
  /** The time zone teammates plan in. */
  setTimezone: base.input(z.object({ timezone: z.string().max(100) })).output(ok),
  /** An OpenAI API key for teammates to continue on when the plan's limit is reached. */
  saveApiKey: base.input(apiKeyInputSchema).output(ok),
  removeApiKey: base.output(ok),
  /** The most the API key may spend in a month. */
  setMonthlyCap: base.input(monthlyCapInputSchema).output(ok),
};
