import { randomUUID } from "node:crypto";
import { egressDevices } from "@open-bot/db";
import { hashDeviceSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, relay, worker } = h;

  describe("connection, account and phone writes", () => {
    it("pairs a phone, pairs it again, and unpairs only the pairing asked for", async () => {
      const phone = randomUUID();
      const device = async () =>
        (await db.select().from(egressDevices).where(eq(egressDevices.id, phone)))[0]!;
      const first = await worker.egress.pairDevice({
        deviceId: phone,
        name: "Pixel 9",
        pushToken: "fcm-1",
      });
      expect(first.generation).toBe(1);
      expect((await device()).secretHash).toBe(hashDeviceSecret(first.secret));
      const second = await worker.egress.pairDevice({
        deviceId: phone,
        name: "Pixel 9",
        pushToken: "fcm-1",
      });
      expect(second).toMatchObject({ generation: 2 });
      expect(second.secret).not.toBe(first.secret);
      // A connection the first pairing still has open is dropped.
      expect(relay.revoke).toHaveBeenLastCalledWith(phone, 1);
      expect(relay.reloadPhones).toHaveBeenCalled();

      relay.reloadPhones.mockClear();
      await worker.egress.devicePushToken({ deviceId: phone, token: "fcm-1" });
      expect(relay.reloadPhones).not.toHaveBeenCalled();
      await worker.egress.devicePushToken({ deviceId: phone, token: "fcm-2" });
      expect((await device()).pushToken).toBe("fcm-2");
      expect(relay.reloadPhones).toHaveBeenCalledOnce();
      await worker.egress.deviceUsed({ deviceId: phone });
      expect((await device()).lastUsedAt).not.toBeNull();

      // A deferred revoke meant for the first pairing doesn't touch the second.
      relay.revoke.mockClear();
      await worker.egress.unpairDevice({ deviceId: phone, generation: 1 });
      expect((await device()).revokedAt).toBeNull();
      expect(relay.revoke).not.toHaveBeenCalled();
      await worker.egress.unpairDevice({ deviceId: phone, generation: 2 });
      expect(await device()).toMatchObject({ pushToken: null, revokedAt: expect.any(Date) });
      expect(relay.revoke).toHaveBeenLastCalledWith(phone, 2);
    });
  });
});
