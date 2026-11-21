import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { apiFor, testLabel } from "./helpers";

test("see a paired phone in Browsing settings and remove it", async ({ page }) => {
  await page.goto("/settings#browsing");
  const api = apiFor(page);
  // Pairing happens on the phone; the API call is what its Settings → Phone connection makes.
  const deviceId = randomUUID();
  const name = testLabel("Pixel");
  await api.egress.registerDevice({ deviceId, name, pushToken: null });
  try {
    await page.reload();
    const devices = page.getByTestId("browsing-devices");
    const row = devices.getByTestId(`paired-phone-${deviceId}`);
    await expect(row).toContainText(name);
    await expect(row).toContainText("Never used");
    await expect(page.getByTestId("browsing-path")).toBeVisible();
    // With a phone paired, when it helps is a choice.
    await expect(
      page.getByRole("radiogroup", { name: "When your phone carries the browsing" }),
    ).toBeVisible();

    await row.getByRole("button", { name: `Remove ${name}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(row).toHaveCount(0);
    expect((await api.egress.devices()).some((device) => device.id === deviceId)).toBe(false);
  } finally {
    await api.egress.revokeDevice({ deviceId }).catch(() => {});
  }
});
