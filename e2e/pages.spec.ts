import { expect, test, type Page } from "./fixtures";
import {
  e2eStack,
  apiFor,
  createTeammate,
  sendMessage,
  testLabel,
  uniqueName,
  waitForLastRun,
  worker,
} from "./helpers";

const workerUrl = e2eStack().workerUrl;
const workerSecret = process.env.WORKER_SECRET ?? "dev-worker-secret-change-me";

/** A small page that passes the check: the kit's styles, a heading, and text to select. */
function pageHtml(heading: string, lede: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${heading}</title>
  <link rel="stylesheet" href="/lib/kit@1/page.css">
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">E2E</p>
      <h1>${heading}</h1>
      <p class="lede" id="lede">${lede}</p>
    </header>
    <h2 id="how">How it works</h2>
    <p id="body">Requests reach a load balancer, which spreads them over stateless servers. Each server reads from a cache first and falls back to the database.</p>
  </main>
  <script src="/lib/kit@1/kit.js"></script>
</body>
</html>`;
}

async function writeFile(path: string, text: string) {
  await worker.files.write({
    path,
    dataBase64: Buffer.from(text).toString("base64"),
  });
}

async function publish(body: Record<string, unknown>) {
  const response = await fetch(`${workerUrl}/internal/pages/publish`, {
    method: "POST",
    headers: { "x-worker-secret": workerSecret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    data: (await response.json()) as {
      pageId?: string;
      versionId?: string;
      version?: number;
      error?: string;
    },
  };
}

async function newTeammate(page: Page) {
  const name = uniqueName("Tess");
  await createTeammate(page, name, "page tester");
  const state = await apiFor(page).app.state();
  const teammate = state.teammates.find((candidate) => candidate.name === name)!;
  return { ...teammate, folder: `/home/bot/bots/${teammate.slug}` };
}

/** The frame showing the page, once it has loaded. */
async function pageFrame(page: Page, heading: string) {
  const frame = page.frameLocator('[data-testid="page-frame"]');
  await expect(frame.locator("h1")).toHaveText(heading, { timeout: 20_000 });
  const handle = await page.getByTestId("page-frame").elementHandle();
  return (await handle!.contentFrame())!;
}

test("a published page opens in the library, isolated from the app, with its versions", async ({
  page,
}) => {
  const teammate = await newTeammate(page);
  const title = testLabel(`Page ${teammate.slug}`);
  await writeFile(
    `${teammate.folder}/index.html`,
    pageHtml("How caching works", "Caches keep hot data close."),
  );
  const first = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/index.html`,
    title,
    summary: "A short explainer for the test.",
  });
  expect(first.status, first.data.error).toBe(200);
  expect(first.data.version).toBe(1);

  // Publishing the same file again without a change is refused.
  const again = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/index.html`,
    title,
  });
  expect(again.status).toBe(400);
  expect(again.data.error).toContain("already exactly this file");

  // In the library, with its picture.
  await page.goto("/pages");
  const tile = page.getByTestId("page-tile").filter({ hasText: title });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText(teammate.name);
  await expect
    .poll(() => tile.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await tile.getByRole("link").click();
  await page.waitForURL(`/pages/${first.data.pageId}`);
  await expect(page.getByTestId("page-title")).toHaveText(title);
  const frame = await pageFrame(page, "How caching works");

  // The page runs on another origin, sandboxed: no network, no app, no cookies or storage.
  const appOrigin = new URL(page.url()).origin;
  expect(new URL(frame.url()).origin).not.toBe(appOrigin);
  expect(await frame.evaluate(() => self.origin)).toBe("null");
  expect(
    await frame.evaluate(
      (origin) =>
        fetch(`${origin}/api/rpc/app/state`, { method: "POST" }).then(
          () => "reached",
          () => "blocked",
        ),
      appOrigin,
    ),
  ).toBe("blocked");
  expect(
    await frame.evaluate(() => {
      try {
        return parent.document.title;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  expect(
    await frame.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  // The kit's styles load from the pages origin.
  expect(
    await frame.evaluate(() => getComputedStyle(document.querySelector("main")!).maxWidth),
  ).not.toBe("none");

  // A new version shows up while you look, and you choose when to switch.
  await writeFile(
    `${teammate.folder}/index.html`,
    pageHtml("How caching works, revised", "Caches keep hot data close, and evict the rest."),
  );
  const second = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/index.html`,
    title,
    summary: "A short explainer for the test.",
    note: "Revised the heading.",
  });
  expect(second.data.pageId).toBe(first.data.pageId);
  expect(second.data.version).toBe(2);
  await expect(page.getByTestId("page-newer")).toContainText("Version 2 is ready");
  await page.getByTestId("page-newer").getByRole("button", { name: "Show it" }).click();
  await pageFrame(page, "How caching works, revised");
  await expect(page.getByTestId("page-newer")).toHaveCount(0);

  await page.getByTestId("page-versions").click();
  await expect(page.getByRole("menuitem", { name: /Version 2/ })).toContainText(
    "Revised the heading.",
  );
  await page.getByRole("menuitem", { name: /Version 1/ }).click();
  await pageFrame(page, "How caching works");
  await expect(page).toHaveURL(`/pages/${first.data.pageId}?v=${first.data.versionId}`);
  await expect(page.getByTestId("page-versions")).toContainText("Version 1 (older)");

  // A version opened from a link (like a chat card's) stays on that version after a reload.
  await page.reload();
  await pageFrame(page, "How caching works");

  // Download keeps the libraries working by pointing them at the pages service.
  const download = await page.request.get(`/api/pages/versions/${first.data.versionId}/download`);
  expect(download.headers()["content-disposition"]).toMatch(
    /^attachment; filename="E2E-Page-.*-v1\.html"/,
  );
  const downloaded = await download.text();
  expect(downloaded).toMatch(/href="https?:\/\/[^"]+\/lib\/kit@1\/page\.css"/);
  expect(downloaded).not.toContain("runtime.js");

  // Pin it, and it leads the library.
  await page.getByRole("button", { name: "Page options" }).click();
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await page.goto("/pages");
  await expect(page.getByTestId("page-tile").first()).toContainText(title);
  await expect(page.getByTestId("page-tile").first().getByLabel("Pinned")).toBeVisible();

  // Search finds it by the words on the page.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-input").fill("evict the rest");
  await page.getByTestId("search-page-result").filter({ hasText: title }).click();
  await page.waitForURL(`/pages/${first.data.pageId}`);

  // Deleting it removes it everywhere; its links stop working.
  const { url } = await apiFor(page).pages.open({ versionId: second.data.versionId! });
  await page.getByRole("button", { name: "Page options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL("/pages");
  await expect(page.getByTestId("page-tile").filter({ hasText: title })).toHaveCount(0);
  const gone = await fetch(url);
  expect(gone.status).toBe(404);
  await page.goto(`/pages/${first.data.pageId}`);
  await expect(page.getByText("This page was deleted")).toBeVisible();
});

test("page links are signed and expire", async ({ page }) => {
  const teammate = await newTeammate(page);
  await writeFile(
    `${teammate.folder}/links.html`,
    pageHtml("Signed links", "Only the app can open me."),
  );
  const published = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/links.html`,
    title: testLabel(`Links ${teammate.slug}`),
  });
  expect(published.status, published.data.error).toBe(200);
  const { url, expiresAt } = await apiFor(page).pages.open({
    versionId: published.data.versionId!,
    theme: "dark",
  });
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(5 * 60_000);
  expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);

  const good = await fetch(url);
  expect(good.status).toBe(200);
  const csp = good.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).not.toContain("allow-same-origin");
  expect(good.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await good.text()).toContain("/lib/runtime.js");

  const link = new URL(url);
  const [, signature] = link.searchParams.get("k")!.split(".");
  // Someone else's key, an old one, or none at all.
  for (const key of [
    "",
    `${Math.floor(Date.now() / 1000) - 60}.${signature}`,
    `9999999999.${signature}`,
  ]) {
    link.searchParams.set("k", key);
    const refused = await fetch(link);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("This link has expired");
  }
  // Without the session, the app won't sign one.
  const signedOut = await fetch(new URL("/api/rpc/pages/open", page.url()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { versionId: published.data.versionId } }),
  });
  expect(signedOut.status).toBe(401);
});

test("a page with problems isn't published, and the check says why", async ({ page }) => {
  const teammate = await newTeammate(page);
  await writeFile(
    `${teammate.folder}/broken.html`,
    `<!doctype html><html><head><title>Broken</title></head><body>
<h1 style="width:1200px">Too wide for a phone</h1>
<img src="diagram.png" alt="">
<script src="https://cdn.example.com/lib.js"></script>
<script>fetch("https://example.com/data.json");</script>
</body></html>`,
  );
  const result = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/broken.html`,
    title: testLabel(`Broken ${teammate.slug}`),
  });
  expect(result.status).toBe(400);
  expect(result.data.error).toContain("Not published");
  expect(result.data.error).toContain("viewport");
  expect(result.data.error).toContain("from the internet");
  expect(result.data.error).toContain("relative address");
  expect(result.data.error).toContain("scrolls sideways");

  // Only HTML files in a workspace or the shared folder can be published.
  const outside = await publish({
    teammateId: teammate.id,
    path: "/etc/passwd.html",
    title: testLabel("Outside"),
  });
  expect(outside.status).toBe(400);
});

test("selecting text in a page offers to ask its teammate about it", async ({ page }) => {
  const teammate = await newTeammate(page);
  await writeFile(`${teammate.folder}/ask.html`, pageHtml("Ask me", "Caches keep hot data close."));
  const published = await publish({
    teammateId: teammate.id,
    path: `${teammate.folder}/ask.html`,
    title: testLabel(`Ask ${teammate.slug}`),
  });
  expect(published.status, published.data.error).toBe(200);
  await page.goto(`/pages/${published.data.pageId}`);
  const frame = await pageFrame(page, "Ask me");

  await frame.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("body")!);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page
    .frameLocator('[data-testid="page-frame"]')
    .locator("openbot-ask")
    .getByRole("button", { name: "Ask about this" })
    .click();
  const panel = page.getByTestId("page-ask");
  await expect(panel).toContainText(`Ask ${teammate.name}`);
  await expect(panel).toContainText("How it works");
  await expect(panel).toContainText("Requests reach a load balancer");
  await expect(panel).toContainText(`your chat with ${teammate.name}`);
  await expect(panel.getByRole("button", { name: "Send" })).toBeDisabled();
  await panel.getByLabel("Your question").fill("Why stateless?");
  await expect(panel.getByRole("button", { name: "Send" })).toBeEnabled();
  await panel.getByLabel("Your question").press("Escape");
  await expect(panel).toHaveCount(0);

  // A page can't open the panel for another page, or pretend to be the frame.
  await page.evaluate(() =>
    window.postMessage(
      { source: "openbot-page", type: "ask", quote: "forged", section: null },
      "*",
    ),
  );
  await page.waitForTimeout(300);
  await expect(panel).toHaveCount(0);
});

test.describe("@agent pages made by a teammate", () => {
  test.setTimeout(15 * 60_000);

  test("a teammate builds a page with /page, and you ask about part of it", async ({ page }) => {
    const name = uniqueName("Ivy");
    await createTeammate(page, name, "research assistant");
    await sendMessage(
      page,
      "/page Make a short page explaining how a URL shortener works: the architecture as a diagram, and the trade-offs. Keep it brief.",
    );
    await waitForLastRun(page, ["completed"], 12 * 60_000);
    const card = page.getByTestId("page-card").last();
    await expect(card).toBeVisible();
    await expect(card).toContainText("New page");
    await card.click();
    await page.waitForURL(/\/pages\/[0-9a-f-]+\?v=/);
    const frame = page.frameLocator('[data-testid="page-frame"]');
    await expect(frame.locator("h1")).toBeVisible({ timeout: 20_000 });
    // The diagram drew.
    await expect(frame.locator(".mermaid svg, svg").first()).toBeVisible();

    await page.getByTestId("page-ask-open").click();
    const panel = page.getByTestId("page-ask");
    await panel.getByLabel("Your question").fill("In one sentence, what is the main trade-off?");
    await panel.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.waitForURL(/\/chats\//);
    await expect(page.getByText(/About your page/).last()).toBeVisible();
    await waitForLastRun(page, ["completed"]);
  });
});
