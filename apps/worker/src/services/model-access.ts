import { credentials, settings, usageEntries } from "@open-bot/db";
import { decideAuthMode, formatDollars, type AuthDecision } from "@open-bot/shared";
import { decryptSecret } from "@open-bot/shared/secrets";
import { and, eq, gte, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { errorMessage } from "../logger";

/** The provider id Codex uses for API key access, configured per thread. */
export const API_PROVIDER_ID = "openai-api";
/** Codex's built-in provider for the ChatGPT plan. */
export const PLAN_PROVIDER_ID = "openai";

const FALLBACK_LIMIT_MS = 60 * 60_000;

/** Codex provider settings for a thread on the given access mode. */
export function providerFor(
  mode: "plan" | "api_key",
  apiKey: string | null,
  env: { OPENAI_API_BASE_URL: string; OPEN_BOT_PLAN_BASE_URL?: string },
): { modelProvider: string; config?: Record<string, unknown> } {
  if (mode === "api_key") {
    return {
      modelProvider: API_PROVIDER_ID,
      config: {
        [`model_providers.${API_PROVIDER_ID}`]: {
          name: "OpenAI API",
          base_url: env.OPENAI_API_BASE_URL,
          wire_api: "responses",
          experimental_bearer_token: apiKey ?? "",
        },
      },
    };
  }
  if (env.OPEN_BOT_PLAN_BASE_URL) {
    return {
      modelProvider: "openai-plan-rehearsal",
      config: {
        "model_providers.openai-plan-rehearsal": {
          name: "Plan rehearsal",
          base_url: env.OPEN_BOT_PLAN_BASE_URL,
          wire_api: "responses",
          experimental_bearer_token: "plan-rehearsal",
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
    };
  }
  return { modelProvider: PLAN_PROVIDER_ID };
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Decides whether runs use the ChatGPT plan or the API key, and enforces the monthly cap.
 * The plan is the default; the API key only takes over while Codex reports the plan's limit.
 */
export class ModelAccess {
  constructor(private readonly ctx: Context) {}

  async apiKey(): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ encrypted: credentials.encrypted })
      .from(credentials)
      .where(eq(credentials.kind, "openai_api_key"));
    if (!row) return null;
    try {
      return decryptSecret(row.encrypted, this.ctx.env.ENCRYPTION_KEY);
    } catch (error) {
      this.ctx.log.error("the stored API key can't be decrypted", { error: errorMessage(error) });
      return null;
    }
  }

  async monthSpendMicros(): Promise<number> {
    const [row] = await this.ctx.db
      .select({ total: sql<string>`coalesce(sum(${usageEntries.costMicros}), 0)` })
      .from(usageEntries)
      .where(and(eq(usageEntries.authMode, "api_key"), gte(usageEntries.createdAt, monthStart())));
    return Number(row?.total ?? 0);
  }

  async decide(): Promise<{ decision: AuthDecision; apiKey: string | null; capMicros: number }> {
    const [row] = await this.ctx.db.select().from(settings).where(eq(settings.id, 1));
    const apiKey = await this.apiKey();
    const capMicros = row?.monthlyCapMicros ?? 0;
    const decision = decideAuthMode({
      now: new Date(),
      planLimitedUntil: row?.planLimitedUntil ?? null,
      hasApiKey: apiKey !== null,
      spendMicros: await this.monthSpendMicros(),
      capMicros,
    });
    return { decision, apiKey, capMicros };
  }

  /** Codex said the plan's limit is reached: remember until when, from the plan's own reset time. */
  async markPlanLimited(): Promise<Date> {
    let until = new Date(Date.now() + FALLBACK_LIMIT_MS);
    try {
      const limits = await this.ctx.codex.rateLimits();
      const windows = [limits?.rateLimits.primary, limits?.rateLimits.secondary].filter(
        (window): window is NonNullable<typeof window> => Boolean(window?.resetsAt),
      );
      const exhausted = windows.filter((window) => window.usedPercent >= 100);
      const resets = (exhausted.length ? exhausted : windows).map(
        (window) => window.resetsAt! * 1000,
      );
      if (resets.length) until = new Date(Math.max(...resets));
    } catch (error) {
      this.ctx.log.warn("could not read the plan's reset time", { error: errorMessage(error) });
    }
    await this.ctx.db.update(settings).set({ planLimitedUntil: until }).where(eq(settings.id, 1));
    await publishApp(this.ctx, { type: "auth" });
    return until;
  }

  static blockedMessage(reason: "no_key" | "cap_reached", capMicros: number): string {
    return reason === "no_key"
      ? "Your ChatGPT plan's usage limit is reached. Add an OpenAI API key in Settings to keep going until it resets."
      : `This month's API spending reached your ${formatDollars(capMicros)} cap. Raise it in Settings, or wait for your ChatGPT plan's limit to reset.`;
  }
}
