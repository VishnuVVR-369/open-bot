import { assertNoDevSecrets, parseEnv, unsetIfEmpty } from "@open-bot/domain/server";
import { z } from "zod";

const schema = z.object({
  /** `production` on Railway: refuses the public development token. Local Compose leaves it unset. */
  NODE_ENV: z.string().optional(),
  /** Authenticates the worker's calls. The worker sends the same value. */
  BOTD_TOKEN: z
    .string({ error: "set it to at least 16 characters" })
    .min(16, "set it to at least 16 characters"),
  /** The computer may sleep and wake. Also lowers the screen defaults. Set the same on the worker. */
  COMPUTER_LIFECYCLE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  /** The group of the shared folders, set in the image. */
  BOTS_GID: unsetIfEmpty(z.coerce.number().int().nonnegative()), // vocabulary: allow
  /** Extra sites the apply guard covers, besides the job portals: the e2e tests' stand-in portal. */
  APPLY_GUARD_EXTRA_DOMAINS: z.string().default(""),
  MAX_SCREENS: unsetIfEmpty(z.coerce.number().int().positive()),
  /** 0 stops a screen nobody uses at the next sweep. */
  SCREEN_IDLE_MINUTES: unsetIfEmpty(z.coerce.number().nonnegative()),
  /** Where the page preview server serves `/lib` from. The image copies the page kit there. */
  PAGE_LIB_DIR: unsetIfEmpty(z.string()),
});

export interface BotdEnv {
  token: string;
  lifecycleEnabled: boolean;
  /** The group of the shared folders, or null for the group of the user teammates run as. */
  sharedGid: number | null;
  applyGuardExtraDomains: string[];
  maxScreens: number;
  screenIdleMs: number;
  pageLibDir: string;
}

/**
 * botd's settings, the only place it reads the environment. Throws a readable message when one is
 * missing or invalid.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): BotdEnv {
  const env = parseEnv(schema, source);
  assertNoDevSecrets({ BOTD_TOKEN: env.BOTD_TOKEN }, env.NODE_ENV);
  const lifecycleEnabled = env.COMPUTER_LIFECYCLE_ENABLED;
  return {
    token: env.BOTD_TOKEN,
    lifecycleEnabled,
    sharedGid: env.BOTS_GID ?? null, // vocabulary: allow
    applyGuardExtraDomains: env.APPLY_GUARD_EXTRA_DOMAINS.split(",")
      .map((domain) => domain.trim())
      .filter(Boolean),
    maxScreens: env.MAX_SCREENS ?? (lifecycleEnabled ? 2 : 4),
    screenIdleMs: (env.SCREEN_IDLE_MINUTES ?? (lifecycleEnabled ? 3 : 20)) * 60_000,
    pageLibDir: env.PAGE_LIB_DIR ?? "/opt/page-kit/lib",
  };
}
