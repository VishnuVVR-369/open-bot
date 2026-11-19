import { apiKeySpendMicros, credentials, ownerSettings } from "@open-bot/db";
import {
  type AuthDecision,
  type AuthMode,
  type BlockedReason,
  type FallbackOffReason,
  decideAuthMode,
  formatDollars,
  monthStart,
} from "@open-bot/domain";
import { decryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { WorkerError } from "../../core/errors";
import {
  type ModelProxyEnv,
  PLAN_PREFIX,
  REHEARSAL_TOKEN,
  type UnsavedApiSpend,
  modelProxyUrl,
} from "../model-logs";
import { errorMessage } from "../../logger";
import { saveSettings } from "../settings";

/** The provider id Codex uses for API key access, configured per thread. */
export const API_PROVIDER_ID = "openai-api";
/** Codex's built-in provider for the ChatGPT plan. */
export const PLAN_PROVIDER_ID = "openai";

const FALLBACK_LIMIT_MS = 60 * 60_000;

/** Thrown for a thread on the API key while the model proxy is off, which `decide` never allows. */
export class UnloggedApiKeyError extends WorkerError {
  constructor() {
    super(
      503,
      "The API key is only used through the model proxy, so its spend is logged and capped.",
    );
  }
}

/**
 * Codex provider settings for a thread on the given access mode. `route` names where the thread's
 * requests go when that differs from Codex's default, so a change in it forks the thread: a loaded
 * thread keeps the provider it was started with.
 *
 * The API key goes only through the model proxy: the cap counts its spend from the model logs, so
 * spend that skips the proxy couldn't be capped. With the proxy off this throws; `decide` never
 * picks the key then.
 */
export function providerFor(
  mode: AuthMode,
  env: ModelProxyEnv & { OPENAI_API_BASE_URL: string; OPEN_BOT_PLAN_BASE_URL?: string },
): { modelProvider: string; config?: Record<string, unknown>; route?: string } {
  if (mode === "api_key") {
    const proxy = modelProxyUrl(env, "api");
    if (!proxy) throw new UnloggedApiKeyError();
    // The key stays in the worker, which adds it to each request; Codex sends none.
    return {
      modelProvider: API_PROVIDER_ID,
      config: {
        [`model_providers.${API_PROVIDER_ID}`]: {
          name: "OpenAI API",
          base_url: proxy,
          wire_api: "responses",
        },
      },
      route: proxy,
    };
  }
  const proxy = modelProxyUrl(env, "plan");
  // The plan's route ends like ChatGPT's own base URL, so Codex keeps the built-in provider's
  // Codex backend behavior (WebSockets, workspace routing, its headers) through the proxy.
  const planRoute = proxy && `${proxy}${PLAN_PREFIX}`;
  if (env.OPEN_BOT_PLAN_BASE_URL) {
    // A rehearsal: a stand-in answers for the plan, through the proxy when it is on, which also
    // replaces every credential on the way so the stand-in never sees a real one.
    return {
      modelProvider: "openai-plan-rehearsal",
      config: {
        "model_providers.openai-plan-rehearsal": {
          name: "Plan rehearsal",
          base_url: planRoute ?? env.OPEN_BOT_PLAN_BASE_URL,
          wire_api: "responses",
          experimental_bearer_token: REHEARSAL_TOKEN,
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
      ...(planRoute ? { route: planRoute } : {}),
    };
  }
  // Codex's built-in provider, pointed at the proxy. Codex sends its own ChatGPT login, which the
  // proxy passes through and never stores.
  if (planRoute)
    return {
      modelProvider: PLAN_PROVIDER_ID,
      config: { openai_base_url: planRoute },
      route: planRoute,
    };
  return { modelProvider: PLAN_PROVIDER_ID };
}

/** No model log writer: nothing held in memory (tests, and a worker without the proxy). */
const NOTHING_UNSAVED: UnsavedApiSpend = { pendingApiCostMicros: () => 0, apiTrouble: () => null };

/**
 * Decides whether runs use the ChatGPT plan or the API key, and enforces the monthly cap.
 * The plan is the default; the API key only takes over while Codex reports the plan's limit.
 *
 * The cap counts the key's spend from the model logs, and from what the model log writer holds
 * that isn't saved yet (`unsaved`). While some of that spend can't be counted, the key isn't
 * used at all (`fallbackOff`). Nothing here ever holds up a model request already let through.
 */
export class ModelAccess {
  constructor(
    private readonly ctx: Context,
    private readonly unsaved: UnsavedApiSpend = NOTHING_UNSAVED,
  ) {}

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

  /**
   * What the API key spent this calendar month (UTC): what the database holds
   * (`apiKeySpendMicros`) plus what the model log writer holds that isn't saved yet, both of
   * requests that started this month. The writer is read first, so a record saved in between
   * counts twice rather than not at all.
   */
  async monthSpendMicros(now = new Date()): Promise<number> {
    const since = monthStart(now);
    const unsaved = this.unsaved.pendingApiCostMicros(since);
    return unsaved + (await apiKeySpendMicros(this.ctx.db, since));
  }

  /**
   * Why the API key fallback is off right now, or null when the key's spend can be counted: model
   * logging is off, or the writer can't save API key logs.
   */
  async fallbackOff(now = new Date()): Promise<FallbackOffReason | null> {
    // With the proxy off nothing is logged, so the cap couldn't see the key's spend.
    if (!this.ctx.env.MODEL_PROXY) return "logging_off";
    return this.unsaved.apiTrouble(monthStart(now));
  }

  async decide(): Promise<{ decision: AuthDecision; apiKey: string | null; capMicros: number }> {
    const now = new Date();
    const row = await ownerSettings(this.ctx.db);
    const apiKey = await this.apiKey();
    const capMicros = row?.monthlyCapMicros ?? 0;
    const planLimitedUntil = row?.planLimitedUntil ?? null;
    // The key's spend matters only while the plan is limited, and only while it can be counted.
    const limited = planLimitedUntil !== null && planLimitedUntil > now;
    const fallbackOff = limited ? await this.fallbackOff(now) : null;
    const decision = decideAuthMode({
      now,
      planLimitedUntil,
      hasApiKey: apiKey !== null,
      fallbackOff,
      spendMicros: limited && !fallbackOff ? await this.monthSpendMicros(now) : 0,
      capMicros,
    });
    return { decision, apiKey, capMicros };
  }

  /** Codex said the plan's limit is reached: remember until when, from the plan's own reset time. */
  async markPlanLimited(): Promise<Date> {
    let until = new Date(Date.now() + FALLBACK_LIMIT_MS);
    try {
      const limits = await this.ctx.codex.rateLimits(true);
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
    await saveSettings(this.ctx.db, { planLimitedUntil: until });
    await publishApp(this.ctx, { type: "auth" });
    return until;
  }

  static blockedMessage(reason: BlockedReason, capMicros: number): string {
    switch (reason) {
      case "no_key":
        return "Your ChatGPT plan's usage limit is reached. Add an OpenAI API key in Settings to keep going until it resets.";
      case "cap_reached":
        return `This month's API spending reached your ${formatDollars(capMicros)} cap. Raise it in Settings, or wait for your ChatGPT plan's limit to reset.`;
      case "logging_off":
        return "Your ChatGPT plan's usage limit is reached. The API key fallback is off while model logging is off, because its spend couldn't be counted toward your monthly cap. Teammates continue once the plan resets.";
      case "logs_unsaved":
        return "Your ChatGPT plan's usage limit is reached. The API key fallback is paused while model logs can't be saved, because its spend couldn't be counted toward your monthly cap. Teammates continue once the logs are saved or the plan resets.";
    }
  }
}
