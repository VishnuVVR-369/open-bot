import { test, expect } from "./fixtures";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { MemoryService } from "../packages/memory/src/index";

test.describe("versioned memory in an isolated database", () => {
  test.skip(
    !process.env.MEMORY_TEST_DATABASE_URL,
    "Use pnpm test:memory -- --e2e to create the isolated database.",
  );
  const pool = new pg.Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL });
  const botId = randomUUID(),
    peerId = randomUUID();
  const password = "Memory-test-password-only-2026";
  test.beforeAll(async ({ request, baseURL }) => {
    if (
      !/^openbot_memory_test(?:_[a-z0-9]+)?$/.test(
        new URL(process.env.MEMORY_TEST_DATABASE_URL!).pathname.slice(1),
      )
    )
      throw new Error("Isolated database required.");
    const existing = await pool.query('select id from "user"');
    if (!existing.rowCount) {
      const response = await request.post("/api/auth/sign-up/email", {
        headers: { origin: baseURL! },
        data: { name: "Memory Test Owner", email: "memory-e2e@example.test", password },
      });
      expect(response.ok()).toBeTruthy();
    }
    await pool.query(
      "insert into bots(id,name,slug,role,color) values($1,'Memory Tester',$3,'assistant','#7C5CFF'),($2,'Memory Peer',$4,'assistant','#2E9BFF')",
      [botId, peerId, `memory-tester-${botId}`, `memory-peer-${peerId}`],
    );
  });
  test.afterAll(async () => {
    await pool.end();
  });
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("memory-e2e@example.test");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("/");
  });

  test("add, correct, inspect, restore, export and forget a bot memory", async ({ page }) => {
    await page.goto(`/bots/${botId}?tab=memory`);
    await expect(page.getByText("No saved memories yet.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Add memory" }).click();
    await page
      .getByRole("textbox", { name: "Memory", exact: true })
      .fill("I prefer remote engineering roles.");
    await page.getByLabel("Topic key").fill("career.work_arrangement");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    const item = page
      .getByTestId("memory-item")
      .filter({ hasText: "I prefer remote engineering roles." });
    await expect(item).toContainText("Revision 1");
    await page.reload();
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Memory", exact: true })
      .fill("I prefer hybrid engineering roles.");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    const current = page
      .getByTestId("memory-item")
      .filter({ hasText: "I prefer hybrid engineering roles." });
    await expect(current).toContainText("Revision 2");
    await current.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("I prefer remote engineering roles.");
    await page.getByRole("button", { name: "Restore revision 1", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Revision 3");
    await page.keyboard.press("Escape");
    await expect(item).toContainText("Revision 3");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: "test-results/memory-desktop.png", fullPage: true });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export", exact: true }).last().click(),
    ]);
    const stream = await download.createReadStream();
    let text = "";
    for await (const chunk of stream!) text += chunk.toString();
    expect(text).toContain("I prefer remote engineering roles.");
    await page.getByLabel("Search memories").fill("hybrid");
    await expect(page.getByText("No memories match that search.")).toBeVisible();
    await page.getByLabel("Search memories").fill("remote");
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Forget", exact: true }).click();
    await page.getByRole("button", { name: "Forget memory", exact: true }).click();
    await expect(item).toHaveCount(0);
    const revisions = await pool.query(
      "select r.content from memory_revisions r join memory_items m on m.id=r.memory_id where m.bot_id=$1",
      [botId],
    );
    expect(revisions.rowCount).toBe(0);
  });

  test("a stale browser edit cannot overwrite a newer revision", async ({ page, context }) => {
    await page.goto(`/bots/${botId}?tab=memory`);
    await page.getByRole("button", { name: "Add memory" }).click();
    await page
      .getByRole("textbox", { name: "Memory", exact: true })
      .fill("My preferred airline is Example Air.");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    const other = await context.newPage();
    await other.goto(`/bots/${botId}?tab=memory`);
    const item = page.getByTestId("memory-item").filter({ hasText: "Example Air" });
    await item.getByRole("button", { name: "Edit", exact: true }).click();
    await other
      .getByTestId("memory-item")
      .filter({ hasText: "Example Air" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await other
      .getByRole("textbox", { name: "Memory", exact: true })
      .fill("My preferred airline is New Air.");
    await other.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(other.getByTestId("memory-item").filter({ hasText: "New Air" })).toContainText(
      "Revision 2",
    );
    await page
      .getByRole("textbox", { name: "Memory", exact: true })
      .fill("An outdated browser edit.");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("This memory changed");
    await expect(page.getByRole("textbox", { name: "Memory", exact: true })).toHaveValue(
      "An outdated browser edit.",
    );
    await page.getByRole("button", { name: "Reload saved version" }).click();
    await expect(page.getByRole("textbox", { name: "Memory", exact: true })).toHaveValue(
      "My preferred airline is New Air.",
    );
    await page.keyboard.press("Escape");
    await other.close();
  });

  test("confirm a sourced suggestion, manage shared preferences and preserve bot scopes on mobile", async ({
    page,
  }) => {
    const id = randomUUID();
    await pool.query(
      "insert into memory_items(id,bot_id,kind,content,fingerprint,state,source) values($1,$2,'preference','Prefers concise replies','e2e-suggestion','candidate',$3)",
      [id, botId, { type: "extraction" }],
    );
    await page.goto(`/bots/${botId}?tab=memory`);
    const suggestion = page
      .getByTestId("memory-item")
      .filter({ hasText: "Prefers concise replies" });
    await expect(suggestion).toContainText("Suggestion");
    await suggestion.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(suggestion).not.toContainText("Suggestion");
    await page.goto(`/bots/${peerId}?tab=memory`);
    await expect(page.getByText("Prefers concise replies")).toHaveCount(0);
    await page.goto("/settings#about");
    const manager = page.getByTestId("memory-manager");
    await manager.getByRole("button", { name: "Add memory" }).click();
    await page.getByRole("textbox", { name: "Memory", exact: true }).fill("I live in Lisbon.");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(manager).toContainText("I live in Lisbon.");
    expect(
      (await pool.query("select about_me from settings where id=1")).rows[0].about_me,
    ).toContain("Lisbon");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/bots/${botId}?tab=memory`);
    await expect(page.getByRole("button", { name: "Add memory" })).toBeVisible();
    await page.screenshot({ path: "test-results/memory-mobile.png", fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
  });

  test("the run inspector shows supplied facts and redacts them after forgetting", async ({
    page,
  }) => {
    const memory = new MemoryService(pool);
    const item = await memory.save(
      {
        botId,
        content: "E2E inspector: prefers remote roles",
        kind: "preference",
        key: null,
        pinned: false,
        expiresAt: null,
      },
      { kind: "user" },
    );
    const chat = randomUUID(),
      run = randomUUID(),
      message = randomUUID();
    await pool.query(
      "insert into chats(id,kind,title,bot_id) values($1,'direct','Memory context check',$2)",
      [chat, botId],
    );
    await pool.query(
      "insert into messages(id,chat_id,role,text) values($1,$2,'user','Find matching roles')",
      [message, chat],
    );
    await pool.query(
      "insert into runs(id,chat_id,bot_id,trigger,prompt,message_id,status) values($1,$2,$3,'user','Find matching roles',$4,'completed')",
      [run, chat, botId, message],
    );
    await pool.query(
      "insert into memory_contexts(run_id,bot_id,generation,refs) values($1,$2,'1:0:0',$3)",
      [run, botId, JSON.stringify([{ id: item.id, revision: item.revision }])],
    );
    await page.goto(`/chats/${chat}`);
    await page.getByRole("button", { name: "Memory context", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: item.content })).toBeVisible();
    await memory.forget({ id: item.id, expectedRevision: item.revision }, { kind: "user" });
    await expect(page.getByRole("listitem").filter({ hasText: "Forgotten memory" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: item.content })).toHaveCount(0);
  });

  test("memory endpoints require the owner's session", async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    const response = await anonymous.get("/api/memory");
    expect(response.status()).toBe(401);
    await anonymous.dispose();
  });
});
