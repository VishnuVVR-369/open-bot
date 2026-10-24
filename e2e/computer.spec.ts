import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "./fixtures";
import { botIdOf as botId, createTeammate, uniqueName } from "./helpers";

const botd = process.env.BOTD_URL ?? "http://127.0.0.1:7070";
const botdToken = process.env.BOTD_TOKEN ?? "dev-botd-token-change-me";

/** Ask botd to act on a bot's screen, as that bot's run would. */
async function act(botId: string, action: Record<string, unknown>, runId = `e2e-${botId}`) {
  const response = await fetch(`${botd}/computer/action`, {
    method: "POST",
    headers: { authorization: `Bearer ${botdToken}`, "content-type": "application/json" },
    body: JSON.stringify({ run: { runId, botId, botName: "E2E" }, action }),
  });
  return (await response.json()) as { ok: boolean; code?: string };
}

async function release(runId: string) {
  await fetch(`${botd}/lease/run/release`, {
    method: "POST",
    headers: { authorization: `Bearer ${botdToken}`, "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

async function openScreen(page: Page, name: string) {
  await page.goto("/computer");
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByText(`${name}’s screen`)).toBeVisible();
}

test("take over a teammate's screen and hand it back", async ({ page }) => {
  const name = uniqueName("Scr");
  await createTeammate(page, name);
  await openScreen(page, name);
  const screen = page.getByTestId("computer-screen");
  await expect(screen).toHaveAttribute("data-activity", "asleep");

  // Taking over wakes the screen and gives you its mouse and keyboard.
  await page.getByTestId("take-over").click();
  await expect(screen).toHaveAttribute("data-activity", "you", { timeout: 60_000 });
  await expect(screen.locator("canvas")).toBeVisible({ timeout: 30_000 });
  const box = (await screen.locator("canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await page.getByTestId("hand-back").click();
  await page.getByTestId("hand-back-note").fill("Just checking the screen.");
  await page.getByTestId("hand-back-confirm").click();
  await expect(screen).toHaveAttribute("data-activity", "idle");
});

test("handing back right after taking over keeps your note while the screen connects", async ({
  page,
}) => {
  const name = uniqueName("Scr");
  await createTeammate(page, name);
  await openScreen(page, name);
  const screen = page.getByTestId("computer-screen");
  // Awake and showing, as when you watch a teammate work.
  await page.getByTestId("wake-screen").click();
  await expect(screen).toHaveAttribute("data-activity", "idle", { timeout: 60_000 });
  await expect(screen.locator("canvas")).toBeVisible({ timeout: 30_000 });

  // Hold the control connection back until the hand-back note is open, as a slow network would.
  let connect = () => {};
  const held = new Promise<void>((resolve) => (connect = resolve));
  await page.route("**/api/desktop/token", async (route) => {
    await held;
    await route.continue();
  });
  const control = page.waitForEvent("websocket", (socket) => socket.url().includes("mode=control"));

  await page.getByTestId("take-over").click();
  await page.getByTestId("hand-back").click();
  await page.getByTestId("hand-back-note").fill("Only a quick look.");
  connect();
  // The screen is ready for your mouse and keyboard once it starts drawing.
  const socket = await control;
  await socket.waitForEvent("framereceived");
  await expect
    .poll(() => screen.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);

  // Connecting doesn't take the focus away and close it.
  await expect(page.getByTestId("hand-back-note")).toHaveValue("Only a quick look.");
  await expect(page.getByTestId("hand-back-note")).toBeFocused();
  await page.getByTestId("hand-back-confirm").click();
  await expect(screen).toHaveAttribute("data-activity", "idle");
  await page.unroute("**/api/desktop/token");

  // Handing straight back, while the screen is still connecting for you, closes it quietly.
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (let round = 0; round < 3; round += 1) {
    await page.getByTestId("take-over").click();
    await page.getByTestId("hand-back").click();
    await page.getByTestId("hand-back-confirm").click();
    await expect(screen).toHaveAttribute("data-activity", "idle");
  }
  await page.waitForTimeout(1_000);
  expect(errors).toEqual([]);
});

test("a bot can't use its screen while you have control, and the others keep working", async ({
  page,
}) => {
  const mine = uniqueName("Held");
  const other = uniqueName("Free");
  await createTeammate(page, mine);
  await createTeammate(page, other);
  const [mineId, otherId] = [await botId(page, mine), await botId(page, other)];

  await openScreen(page, mine);
  await page.getByTestId("take-over").click();
  await expect(page.getByTestId("computer-screen")).toHaveAttribute("data-activity", "you", {
    timeout: 60_000,
  });

  expect(await act(mineId, { action: "screenshot" })).toMatchObject({
    ok: false,
    code: "user_has_control",
  });
  expect(await act(otherId, { action: "screenshot" })).toMatchObject({ ok: true });
  await release(`e2e-${otherId}`);

  await page.getByTestId("hand-back").click();
  await page.getByTestId("hand-back-confirm").click();
  await expect(page.getByTestId("computer-screen")).toHaveAttribute("data-activity", "idle");
});

test("a sign-in on one screen reaches every teammate's browser", async ({ page }) => {
  // A tiny site that hands out a session cookie and reports the cookies it is sent back.
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/sign-in")) {
      response.setHeader(
        "set-cookie",
        `e2e_session=${new URL(request.url, "http://x").searchParams.get("v")}; Path=/; Max-Age=600`,
      );
    } else {
      seen.push(request.headers.cookie ?? "");
    }
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const site = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;

  try {
    const a = uniqueName("Ann");
    const b = uniqueName("Bob");
    await createTeammate(page, a);
    await createTeammate(page, b);
    const [aId, bId] = [await botId(page, a), await botId(page, b)];
    const value = Math.random().toString(36).slice(2);

    // Both screens start and work at the same time.
    const [first, second] = await Promise.all([
      act(aId, { action: "open_url", url: `${site}/sign-in?v=${value}` }),
      act(bId, { action: "open_url", url: "about:blank" }),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });

    await expect
      .poll(
        async () => {
          await act(bId, { action: "open_url", url: `${site}/check?t=${Date.now()}` });
          return seen.join(" ");
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toContain(`e2e_session=${value}`);
    await release(`e2e-${aId}`);
    await release(`e2e-${bId}`);
  } finally {
    server.close();
  }
});
