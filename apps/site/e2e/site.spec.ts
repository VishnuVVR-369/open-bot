import { expect, test, type Page } from "@playwright/test";

const media = "http://localhost:3301";

type TourMedia = HTMLVideoElement & { videoRenditions?: ArrayLike<{ height: number }> };

/** Collects console errors and content security policy violations. */
function watchForProblems(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

function mediaRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(media)) urls.push(request.url().slice(media.length));
  });
  return urls;
}

const tour = (page: Page) => page.locator("hls-video");

async function tourState(page: Page) {
  return tour(page).evaluate((el: TourMedia) => ({
    time: el.currentTime,
    paused: el.paused,
    muted: el.muted,
    renditions: Array.from(el.videoRenditions ?? []).map((r) => r.height),
    tracks: Array.from(el.textTracks).map((t) => ({ kind: t.kind, mode: t.mode })),
  }));
}

test("the page loads with its security headers and no errors", async ({ page }) => {
  const problems = watchForProblems(page);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(`connect-src 'self' ${media}`);

  await expect(
    page.getByRole("heading", { level: 1, name: "Your AI teammates, and the computer they share" }),
  ).toBeVisible();
  for (const name of [
    "Give them a job",
    "Watch them work",
    "Take the wheel. Anytime",
    "Nothing ships without your OK",
    "Many hands at once",
    "And the rest",
    "Run it yourself",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeAttached();
  }

  // Every in-page link lands on a section.
  const anchors = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")!));
  for (const href of anchors) await expect(page.locator(href)).toBeAttached();

  // Share previews get a title, an image and the video.
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /opengraph-image/,
  );
  await expect(page.locator('meta[property="og:video"]')).toHaveAttribute(
    "content",
    `${media}/tour/v1/open-bot-tour.mp4`,
  );

  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("only the playlist loads until someone presses play", async ({ page }) => {
  const requests = mediaRequests(page);
  await page.goto("/");
  await expect(tour(page)).toBeAttached();
  await page.waitForLoadState("networkidle");
  expect(requests).toEqual(["/tour/v1/master.m3u8"]);
});

test("the tour plays with sound, adaptive quality, captions and scrub thumbnails", async ({
  page,
}) => {
  const problems = watchForProblems(page);
  const requests = mediaRequests(page);
  await page.goto("/");
  await expect(tour(page)).toBeAttached();

  await page.getByRole("button", { name: /Play the open-bot tour/ }).click();
  await expect.poll(async () => (await tourState(page)).time).toBeGreaterThan(1.5);

  const state = await tourState(page);
  expect(state.paused).toBe(false);
  expect(state.muted).toBe(false);
  expect(state.renditions).toEqual(expect.arrayContaining([480, 720, 1080]));
  expect(state.tracks).toEqual(
    expect.arrayContaining([
      { kind: "captions", mode: "disabled" },
      { kind: "metadata", mode: "hidden" },
      { kind: "chapters", mode: "showing" },
    ]),
  );
  expect(requests.some((url) => url.endsWith(".m4s"))).toBe(true);

  // The tally light goes on air while the tour plays.
  await expect(page.locator(".tally")).toHaveAttribute("data-state", "on");
  await page.locator("media-controller").hover();
  await expect(page.locator("media-time-display")).toBeVisible();
  expect(problems).toEqual([]);
});

test("captions come on when the sound goes off", async ({ page }) => {
  await page.goto("/");
  await expect(tour(page)).toBeAttached();
  await page.getByRole("button", { name: /Play the open-bot tour/ }).click();
  await expect.poll(async () => (await tourState(page)).time).toBeGreaterThan(0.5);

  await tour(page).evaluate((el: HTMLVideoElement) => (el.muted = true));
  await expect
    .poll(async () => (await tourState(page)).tracks.find((t) => t.kind === "captions")?.mode)
    .toBe("showing");
});

test("a chapter plays from where it starts, on the monitor", async ({ page }) => {
  const requests = mediaRequests(page);
  await page.goto("/");
  await expect(tour(page)).toBeAttached();

  const takeover = page.locator("#takeover");
  await takeover.scrollIntoViewIfNeeded();
  await takeover.getByRole("button", { name: /Play this part/ }).click();

  await expect(page.locator("#tour")).toBeInViewport();
  await expect.poll(async () => (await tourState(page)).time).toBeGreaterThan(38.5);
  expect((await tourState(page)).time).toBeLessThan(46);
  // The stream starts at the chapter (0:38 is in segment 9) instead of loading the opening first.
  const firstVideoSegment = requests.find((url) => /\/\d+p\/seg-\d+\.m4s$/.test(url));
  expect(firstVideoSegment).toMatch(/\/seg-009\.m4s$/);

  // The chapter rail marks where the tour is.
  await expect(page.getByRole("button", { name: /Play from 0:38/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
});

test("the end of the tour offers the code and a replay", async ({ page }) => {
  await page.goto("/");
  await expect(tour(page)).toBeAttached();
  await page.getByRole("button", { name: "Play from 1:04: And the rest" }).click();
  await expect.poll(async () => (await tourState(page)).time).toBeGreaterThan(64);

  await tour(page).evaluate((el: HTMLVideoElement) => {
    el.currentTime = el.duration - 0.5;
  });
  await expect(page.getByText("That’s open-bot")).toBeVisible();
  await expect(page.locator("#tour").getByRole("link", { name: "View on GitHub" })).toBeVisible();

  await page.getByRole("button", { name: "Watch again" }).click();
  await expect.poll(async () => (await tourState(page)).time).toBeLessThan(5);
  await expect(page.getByText("That’s open-bot")).toBeHidden();
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero shows a still instead of the loop", async ({ page }) => {
    const loops: string[] = [];
    page.on("request", (r) => r.url().includes("hero-loop") && loops.push(r.url()));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('img[src="/media/hero-poster.jpg"]')).toBeVisible();
    expect(loops).toEqual([]);
  });
});

test("the hero loop plays muted while it is on screen", async ({ page }) => {
  await page.goto("/");
  const loop = page.locator("video").filter({ has: page.locator('source[src*="hero-loop"]') });
  await expect.poll(() => loop.evaluate((v: HTMLVideoElement) => !v.paused && v.muted)).toBe(true);
  await expect(loop).toHaveCSS("opacity", "1");
});

test("the downloadable tour supports range requests across origins", async ({ request }) => {
  const response = await request.get(`${media}/tour/v1/open-bot-tour.mp4`, {
    headers: { Range: "bytes=0-1023", Origin: "http://localhost:3300" },
  });
  expect(response.status()).toBe(206);
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-1023\/\d+$/);
  expect(response.headers()["access-control-allow-origin"]).toBeTruthy();
});

test("unknown pages get the open-bot 404", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page doesn’t exist" })).toBeVisible();
  await page.getByRole("link", { name: "Go to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the quickstart copies to the clipboard", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Clipboard permissions are Chromium only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const run = page.locator("#run");
  await run.getByRole("button", { name: "Copy" }).click();
  await expect(run.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("git clone https://github.com/VishnuVVR-369/open-bot.git");
  expect(copied).not.toContain("$ ");
});
