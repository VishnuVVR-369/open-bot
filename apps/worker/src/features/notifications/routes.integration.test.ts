import { notifications } from "@open-bot/db";
import { isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, services, worker } = h;

  it("push: a browser outside https can't subscribe, and a phone can register", async () => {
    expect(
      await failure(
        worker.push.subscribe({
          subscription: { endpoint: "http://push.test/1", keys: { p256dh: "k", auth: "a" } },
        }),
      ),
    ).toEqual({ status: 400, message: "Push services use https." });
    await worker.push.registerNative({ token: "fcm-token", platform: "android" });
    expect(services.fcm.register).toHaveBeenLastCalledWith({
      token: "fcm-token",
      platform: "android",
      device: "",
    });
    expect((await worker.push.status()).devices).toEqual([]);
  });
  describe("vault, page and notification writes", () => {
    it("marks notifications read by id, up to one, or all", async () => {
      await db.update(notifications).set({ readAt: new Date() });
      const added = [];
      for (const title of ["One", "Two", "Three", "Four"]) {
        const [row] = await db
          .insert(notifications)
          .values({ kind: "run_finished", title })
          .returning();
        added.push(row!);
      }
      const unread = async () =>
        (await db.select().from(notifications).where(isNull(notifications.readAt)))
          .map((row) => row.title)
          .sort();
      await worker.notifications.markRead({ ids: [added[3]!.id] });
      expect(await unread()).toEqual(["One", "Three", "Two"]);
      await worker.notifications.markRead({ through: added[1]!.id });
      expect(await unread()).toEqual(["Three"]);
      await worker.notifications.markRead({});
      expect(await unread()).toEqual([]);
    });
  });
});
