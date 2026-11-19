import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { apiKeySpendMicros, credentials, ownerSettings } from "@open-bot/db";
import { monthStart } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";
import { workerStatus } from "@/lib/server/worker-status";
import { monthlyUsage } from "@/features/model-logs/server";
import type { ModelAccessView, UsageView } from "@/lib/types";

/**
 * Your settings. The worker saves them (it owns them, see packages/db/src/owners.ts); the reads
 * here show them, with the API key fallback and this month's usage.
 */

type Inputs = ApiInputs["settings"];
type Ok = { ok: true };

export async function setTimezone({ timezone }: Inputs["setTimezone"]): Promise<Ok> {
  return worker.settings.setTimezone({ timezone });
}

/* ------------------------------------------------------------------ When the plan runs out */

export async function saveApiKey({ apiKey }: Inputs["saveApiKey"]): Promise<Ok> {
  return worker.settings.saveApiKey({ apiKey });
}

export async function removeApiKey(): Promise<Ok> {
  return worker.settings.removeApiKey();
}

export async function setMonthlyCap({ dollars }: Inputs["setMonthlyCap"]): Promise<Ok> {
  return worker.settings.setMonthlyCap({ dollars });
}

/**
 * The API key fallback: the key's hint, this month's spend (what the cap counts,
 * `apiKeySpendMicros`) and cap, whether the plan ran out, and why the fallback is off, when the
 * worker says it is (an unreachable worker isn't taken to say so).
 */
export async function getModelAccess(): Promise<ModelAccessView> {
  const [row, [key], spendMicros, status] = await Promise.all([
    ownerSettings(db),
    db
      .select({ hint: credentials.hint })
      .from(credentials)
      .where(eq(credentials.kind, "openai_api_key")),
    apiKeySpendMicros(db, monthStart()),
    workerStatus(),
  ]);
  const limitedUntil =
    row?.planLimitedUntil && row.planLimitedUntil > new Date() ? row.planLimitedUntil : null;
  return {
    keyHint: key?.hint ?? null,
    capMicros: row?.monthlyCapMicros ?? 0,
    spendMicros,
    planLimitedUntil: limitedUntil?.toISOString() ?? null,
    fallbackOff: status?.apiFallbackOff ?? null,
  };
}

/** Tokens each teammate used this month (`monthlyUsage`). */
export async function getMonthlyUsage(): Promise<UsageView[]> {
  return monthlyUsage(monthStart());
}
