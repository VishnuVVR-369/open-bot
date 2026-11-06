import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  OFFLINE_EGRESS_STATUS,
  type ApiInputs,
  type EgressDeviceView,
  type EgressStatusView,
} from "@open-bot/api";
import { egressDevices } from "@open-bot/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { workerStatus } from "../queries";
import { worker } from "../worker";

type Inputs = ApiInputs["egress"];

/** The SHA-256 of a device secret, as stored. */
export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Tell the worker that paired phones changed, so it wakes the right ones. Best effort. */
async function devicesChanged(): Promise<void> {
  await worker("POST", "/internal/egress/devices/changed").catch(() => {});
}

export async function getEgressStatus(): Promise<EgressStatusView> {
  const status = await workerStatus();
  return status?.egress ?? OFFLINE_EGRESS_STATUS;
}

export async function setEgressMode({ mode }: Inputs["setMode"]) {
  await worker("POST", "/internal/egress/mode", { mode });
  return { ok: true as const };
}

export async function setPhoneEgressMode({ mode }: Inputs["setPhoneMode"]) {
  await worker("POST", "/internal/egress/phone-mode", { mode });
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
 * an earlier pairing stops working. The secret is returned once and only its hash is kept.
 */
export async function registerEgressDevice({
  deviceId,
  name,
  pushToken,
}: Inputs["registerDevice"]) {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashDeviceSecret(secret);
  const [row] = await db
    .insert(egressDevices)
    .values({ id: deviceId, name, secretHash, pushToken, generation: 1 })
    .onConflictDoUpdate({
      target: egressDevices.id,
      set: {
        name,
        secretHash,
        pushToken,
        generation: sql`${egressDevices.generation} + 1`,
        revokedAt: null,
      },
    })
    .returning({ generation: egressDevices.generation });
  // A re-pairing must also drop a connection the previous generation still has open.
  await worker("POST", `/internal/egress/devices/${deviceId}/revoked`, {
    generation: row!.generation - 1,
  }).catch(() => {});
  await devicesChanged();
  return { secret, generation: row!.generation };
}

/**
 * Unpair a phone. The database is the source of truth; the worker is told so it can disconnect
 * the phone at once, and its reconciler catches up if that message is lost.
 */
export async function revokeEgressDevice({ deviceId, generation }: Inputs["revokeDevice"]) {
  const [row] = await db
    .update(egressDevices)
    .set({ revokedAt: new Date(), pushToken: null })
    .where(
      and(
        eq(egressDevices.id, deviceId),
        isNull(egressDevices.revokedAt),
        ...(generation === undefined ? [] : [eq(egressDevices.generation, generation)]),
      ),
    )
    .returning({ generation: egressDevices.generation });
  if (row) {
    await worker("POST", `/internal/egress/devices/${deviceId}/revoked`, {
      generation: row.generation,
    }).catch(() => {});
    await devicesChanged();
  }
  return { ok: true as const };
}
