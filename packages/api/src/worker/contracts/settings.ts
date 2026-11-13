import { base, computer, ok } from "../base";
import { chatgptAuthSourceSchema } from "@open-bot/domain";
import { z } from "zod";
import { apiKeyInputSchema, monthlyCapInputSchema } from "../../settings";
import { codexRateLimitsSchema, codexStatusSchema } from "../views";

export const settingsContract = {
  /** The time zone teammates plan in. */
  setTimezone: base
    .route({ method: "POST", path: "/internal/settings/timezone" })
    .input(z.object({ timezone: z.string().max(100) }))
    .output(ok),
  /** The most the API key may spend in a month. */
  setMonthlyCap: base
    .route({ method: "POST", path: "/internal/settings/monthly-cap" })
    .input(monthlyCapInputSchema)
    .output(ok),
  /** The OpenAI API key teammates continue on when the plan's limit is reached. */
  saveApiKey: base
    .route({ method: "POST", path: "/internal/settings/api-key" })
    .input(apiKeyInputSchema)
    .output(ok),
  removeApiKey: base
    .route({ method: "POST", path: "/internal/settings/api-key/delete" })
    .output(ok),
};

export const codexContract = {
  /** Start a device-code sign-in to ChatGPT. */
  deviceLogin: computer
    .route({ method: "POST", path: "/internal/codex/device-login" })
    .output(z.object({ verificationUrl: z.string(), userCode: z.string() })),
  /** Sign in with a device code, or with the login of the Mac running the stack. */
  setAuthSource: computer
    .route({ method: "POST", path: "/internal/codex/auth-source" })
    .input(z.object({ source: chatgptAuthSourceSchema }))
    .output(codexStatusSchema),
  logout: computer.route({ method: "POST", path: "/internal/codex/logout" }).output(ok),
  /** ChatGPT's usage limits, as last read; reading them never wakes the computer. */
  rateLimits: base
    .route({ method: "GET", path: "/internal/codex/rate-limits" })
    .output(codexRateLimitsSchema),
};
