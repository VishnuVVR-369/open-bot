import "server-only";
import {
  OFFLINE_EGRESS_STATUS,
  type ApiInputs,
  type EgressDeviceView,
  type EgressStatusView,
} from "@open-bot/api";
import { egressDevices } from "@open-bot/db";
import { asc, isNull } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { workerStatus } from "@/lib/server/queries";
import { worker } from "@/lib/server/worker";

type Inputs = ApiInputs["egress"];

export async function getEgressStatus(): Promise<EgressStatusView> {
  const status = await workerStatus();
  return status?.egress ?? OFFLINE_EGRESS_STATUS;
}

export async function setEgressMode({ mode }: Inputs["setMode"]) {
  await worker.egress.setMode({ mode });
  return { ok: true as const };
}

export async function setPhoneEgressMode({ mode }: Inputs["setPhoneMode"]) {
  await worker.egress.setPhoneMode({ mode });
  return { ok: true as const };
}

export async function listEgressDevices(): Promise<EgressDeviceView[]> {
  const [rows, status] = await Promise.all([
    db
      .select()
      .from(egressDevices)
      .where(isNull(egressDevices.revokedAt))
      .orderBy(asc(egressDevices.createdAt)),
    workerStatus(),
  ]);
  const online = new Set(
    (status?.egress.agents ?? [])
      .filter((agent) => agent.kind === "phone")
      .map((agent) => agent.id),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    online: online.has(row.id),
  }));
}

/**
 * Pair a phone, or pair it again: a new secret and a new generation, so any token or secret from
 * an earlier pairing stops working. The worker keeps only the secret's hash (it owns paired phones,
 * see packages/db/src/owners.ts), and the secret is returned once.
 */
export async function registerEgressDevice({
  deviceId,
  name,
  pushToken,
}: Inputs["registerDevice"]) {
  return worker.egress.pairDevice({ deviceId, name, pushToken });
}

/** Unpair a phone; the worker disconnects it at once. */
export async function revokeEgressDevice({ deviceId, generation }: Inputs["revokeDevice"]) {
  await worker.egress.unpairDevice({ deviceId, generation });
  return { ok: true as const };
}
