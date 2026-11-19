import "server-only";
import type { ModelLogRetentionView } from "@open-bot/api";
import { ownerSettings } from "@open-bot/db";
import { sql } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";

/**
 * How long model logs keep their bodies. The worker owns the setting and runs the sweep; this
 * reads the setting and how far the sweeps have got.
 */
export async function getRetention(): Promise<ModelLogRetentionView> {
  const [settings, { rows }] = await Promise.all([
    ownerSettings(db),
    db.execute<{ oldest: Date | null; expired: Date | null }>(sql`
      select (select min(started_at) from model_requests where bodies_expired_at is null) as oldest,
        (select max(bodies_expired_at) from model_requests) as expired`),
  ]);
  const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
  return {
    days: settings?.modelLogRetentionDays ?? null,
    oldestKept: iso(rows[0]?.oldest),
    lastExpiredAt: iso(rows[0]?.expired),
  };
}

export async function setRetention({ days }: { days: number | null }): Promise<{ ok: true }> {
  return worker.settings.setModelLogRetention({ days });
}
