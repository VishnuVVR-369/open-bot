import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { services, worker } = h;

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
});
