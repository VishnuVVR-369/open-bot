import { randomBytes } from "node:crypto";
import { egressDevices, type Queryable } from "@open-bot/db";
import { hashDeviceSecret } from "@open-bot/domain/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "../context";
import { errorMessage } from "../logger";
import type { EgressRelay } from "./relay";

/** Paired phones that carry the computer's traffic. Only this module writes `egress_devices`. */

/** Forget a push token FCM says is gone, on any phone that had it. */
export async function forgetPushToken(db: Queryable, token: string): Promise<void> {
  await db.update(egressDevices).set({ pushToken: null }).where(eq(egressDevices.pushToken, token));
}

export class EgressDevices {
  constructor(
    private readonly ctx: Pick<Context, "db" | "log">,
    private readonly relay: Pick<EgressRelay, "revoke" | "reloadPhones">,
  ) {}

  /**
   * Pair a phone, or pair it again: a new secret and a new generation, so any token or secret from
   * an earlier pairing stops working. The secret is returned once and only its hash is kept.
   */
  async pair(input: {
    deviceId: string;
    name: string;
    pushToken: string | null;
  }): Promise<{ secret: string; generation: number }> {
    const secret = randomBytes(32).toString("base64url");
    const secretHash = hashDeviceSecret(secret);
    const [row] = await this.ctx.db
      .insert(egressDevices)
      .values({
        id: input.deviceId,
        name: input.name,
        secretHash,
        pushToken: input.pushToken,
        generation: 1,
      })
      .onConflictDoUpdate({
        target: egressDevices.id,
        set: {
          name: input.name,
          secretHash,
          pushToken: input.pushToken,
          generation: sql`${egressDevices.generation} + 1`,
          revokedAt: null,
        },
      })
      .returning({ generation: egressDevices.generation });
    // A re-pairing must also drop a connection the previous generation still has open.
    await this.tell(() => this.relay.revoke(input.deviceId, row!.generation - 1));
    await this.relay.reloadPhones();
    return { secret, generation: row!.generation };
  }

  /**
   * Unpair a phone; with `generation`, only that pairing, so a revoke delayed from an offline
   * sign-out can't undo a later pairing. The database is the source of truth: the relay drops the
   * phone now, and its reconciler catches up if that fails.
   */
  async unpair(deviceId: string, generation?: number): Promise<void> {
    const [row] = await this.ctx.db
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
    if (!row) return;
    await this.tell(() => this.relay.revoke(deviceId, row.generation));
    await this.relay.reloadPhones();
  }

  /** FCM gave a paired phone a new token; the relay wakes the phone with it from now on. */
  async setPushToken(deviceId: string, token: string): Promise<void> {
    const changed = await this.ctx.db
      .update(egressDevices)
      .set({ pushToken: token })
      .where(
        and(
          eq(egressDevices.id, deviceId),
          isNull(egressDevices.revokedAt),
          sql`${egressDevices.pushToken} is distinct from ${token}`,
        ),
      )
      .returning({ id: egressDevices.id });
    if (changed.length) await this.relay.reloadPhones();
  }

  /** A paired phone asked to open the tunnel. */
  async markUsed(deviceId: string): Promise<void> {
    await this.ctx.db
      .update(egressDevices)
      .set({ lastUsedAt: new Date() })
      .where(eq(egressDevices.id, deviceId));
  }

  private async tell(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.ctx.log.warn("could not drop a phone's tunnel", { error: errorMessage(error) });
    }
  }
}
