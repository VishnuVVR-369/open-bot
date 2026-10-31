import { expect, test, type Page } from "@playwright/test";
import { allDocs } from "../src/lib/docs";

/** Collects console errors and page errors, including content security policy violations. */
function watchForProblems(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

test("every docs page loads with its title, navigation and no errors", async ({ page }) => {
  const problems = watchForProblems(page);
  for (const doc of allDocs) {
    const response = await page.goto(doc.href);
    expect(response?.status(), doc.href).toBe(200);
    // Let link prefetches finish: WebKit reports ones cut short by the next navigation as errors.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("article.doc h1"), doc.href).toHaveCount(1);
    await expect(page).toHaveTitle(
      doc.href === "/docs"
        ? /open-bot documentation/
        : new RegExp(`^${doc.title} - open-bot docs$`),
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${doc.href}$`),
    );
  }
  expect(problems).toEqual([]);
});

test("every link between docs pages lands on a page and a heading that exist", async ({
  page,
  request,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Links are the same in every browser");
  const targets = new Map<string, Set<string>>();
  for (const doc of allDocs) {
    await page.goto(doc.href);
    const hrefs = await page
      .locator("article.doc a[href^='/'], article.doc a[href^='#']")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")!));
    for (const href of hrefs) {
      const [path, hash] = href.startsWith("#") ? [doc.href, href.slice(1)] : href.split("#");
      const anchors = targets.get(path!) ?? new Set<string>();
      if (hash) anchors.add(hash);
      targets.set(path!, anchors);
    }
  }
  for (const [path, anchors] of targets) {
    expect((await request.get(path)).status(), path).toBe(200);
    if (anchors.size === 0) continue;
    await page.goto(path);
    for (const anchor of anchors) {
      await expect(page.locator(`[id="${anchor}"]`), `${path}#${anchor}`).toHaveCount(1);
    }
  }
});

test("the sidebar marks the current page, and previous and next walk the docs in order", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "The sidebar is the menu on phones");
  await page.goto("/docs/architecture/worker");
  const sidebar = page.getByRole("navigation", { name: "Documentation" });
  await expect(sidebar.getByRole("link", { name: "Worker" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: /^Next/ }).click();
  await expect(page).toHaveURL(/\/docs\/architecture\/computer\/?$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "The computer and botd" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Previous/ }).click();
  await expect(page).toHaveURL(/\/docs\/architecture\/worker\/?$/);
});

test("on this page follows the reading position", async ({ page, isMobile }) => {
  test.skip(isMobile, "The table of contents shows on wide screens");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs/flows/chat-turn");
  const toc = page.getByRole("navigation", { name: "On this page" });
  await toc.getByRole("link", { name: "Finishing" }).click();
  await expect(page).toHaveURL(/#finishing$/);
  await expect(toc.locator("a.font-medium")).toHaveText("Finishing");
});

test("the menu on phones opens, navigates and closes", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Phones only");
  await page.goto("/docs");
  const menu = page.locator("details", { hasText: "Menu" });
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "Security model" }).click();
  await expect(page).toHaveURL(/\/docs\/security\/?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Security model" })).toBeVisible();
  await expect(menu).not.toHaveAttribute("open", "");
});

test("diagrams fit the article on wide screens and scroll on phones", async ({
  page,
  isMobile,
}) => {
  await page.goto("/docs/architecture");
  const figure = page.locator("figure.diagram").first();
  const scroller = figure.locator(":scope > div").first();
  const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  if (isMobile) expect(scrollWidth).toBeGreaterThan(clientWidth);
  else expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  // The page itself never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("the landing page links to the docs, and the sitemap lists them", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/?$/);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const doc of allDocs) expect(sitemap).toContain(`${doc.href}</loc>`);
});
