import { createECDH, randomBytes } from "node:crypto";
import http from "node:http";
import { expect, test } from "./fixtures";
import { workerApi } from "./helpers";

const PORT = 4796;

/** A stand-in for a browser's push service, which records what the worker sends. */
function pushService() {
  const received: { path: string; headers: http.IncomingHttpHeaders; bytes: number }[] = [];
  let status = 201;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        bytes: Buffer.concat(chunks).length,
      });
      response.writeHead(status).end();
    });
  });
  return {
    received,
    goneFromNowOn: () => (status = 410),
    start: () => new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("get push notifications on this device", async ({ page, context }) => {
  const service = pushService();
  await service.start();
  const id = randomBytes(6).toString("hex");
  const endpoint = `http://127.0.0.1:${PORT}/push/${id}`;
  // The browser's keys for this subscription, as a real one would have.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  try {
    await context.grantPermissions(["notifications"]);
    await page.addInitScript(
      ({ endpoint, keys }) => {
        let current: unknown = null;
        const subscription = {
          endpoint,
          toJSON: () => ({ endpoint, keys }),
          unsubscribe: async () => {
            current = null;
            return true;
          },
        };
        PushManager.prototype.subscribe = async () => {
          current = subscription;
          return subscription as unknown as PushSubscription;
        };
        PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
      },
      { endpoint, keys },
    );

    await page.goto("/settings#notifications");
    const section = page.getByTestId("push-section");
    const toggle = section.getByRole("switch", { name: "Notifications on this device" });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(section.getByTestId("push-device").first()).toContainText("this device");

    // A test reaches the push service, encrypted and signed.
    await section.getByRole("button", { name: "Send a test" }).click();
    await expect(page.getByText("Sent to 1 device")).toBeVisible();
    await expect.poll(() => service.received.length).toBe(1);
    const [push] = service.received;
    expect(push!.path).toBe(`/push/${id}`);
    expect(push!.headers["content-encoding"]).toBe("aes128gcm");
    expect(push!.headers.authorization).toMatch(/^vapid t=/);
    expect(push!.bytes).toBeGreaterThan(0);

    // A device the push service says is gone is forgotten.
    service.goneFromNowOn();
    await section.getByRole("button", { name: "Send a test" }).click();
    await expect(page.getByText("Sent to 0 devices")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("push-device")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  } finally {
    await workerApi("/internal/push/unsubscribe", { endpoint }).catch(() => {});
    await service.stop();
  }
});
