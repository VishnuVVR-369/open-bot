import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { credentials, ownerSettings, usageEntries } from "@open-bot/db";
import { monthStart } from "@open-bot/domain";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";
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

/** The API key fallback: the key's hint, this month's spend and cap, and whether the plan ran out. */
export async function getModelAccess(): Promise<ModelAccessView> {
  const row = await ownerSettings(db);
  const [key] = await db
    .select({ hint: credentials.hint })
    .from(credentials)
    .where(eq(credentials.kind, "openai_api_key"));
  const [spend] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEntries.costMicros}), 0)` })
    .from(usageEntries)
    .where(and(eq(usageEntries.authMode, "api_key"), gte(usageEntries.createdAt, monthStart())));
  const limitedUntil =
    row?.planLimitedUntil && row.planLimitedUntil > new Date() ? row.planLimitedUntil : null;
  return {
    keyHint: key?.hint ?? null,
    capMicros: row?.monthlyCapMicros ?? 0,
    spendMicros: Number(spend?.total ?? 0),
    planLimitedUntil: limitedUntil?.toISOString() ?? null,
  };
}

/** Tokens each teammate used this month. */
export async function getMonthlyUsage(): Promise<UsageView[]> {
  const rows = await db
    .select({
      botId: usageEntries.botId,
      runs: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEntries.inputTokens}), 0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${usageEntries.cachedInputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEntries.outputTokens}), 0)::bigint`,
    })
    .from(usageEntries)
    .where(gte(usageEntries.createdAt, monthStart()))
    .groupBy(usageEntries.botId);
  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens),
  }));
}
