import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import { uniqueName } from "./helpers";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});

const LONG = [
  "Create a teammate named Iris, my personal research analyst.",
  "",
  ...Array.from({ length: 24 }, (_, index) => `Point ${index + 1}: track what changed and why.`),
  "Always include source links.",
].join("\n");
const SHORT = "Short one:\nkeep it brief.";

/** A teammate's chat holding your messages, saved as already delivered so no run starts. */
async function seedChat(texts: string[]): Promise<string> {
  const teammateId = randomUUID();
  const chatId = randomUUID();
  const name = uniqueName("Tess");
  await pool.query(
    "insert into bots(id,name,slug,role,color) values($1,$2,$3,'test assistant','#7C5CFF')", // vocabulary: allow
    [teammateId, name, name.toLowerCase()],
  );
  await pool.query(
    "insert into chats(id,kind,title,bot_id) values($1,'direct','Long message check',$2)", // vocabulary: allow
    [chatId, teammateId],
  );
  for (const [index, text] of texts.entries())
    await pool.query(
      "insert into messages(chat_id,role,text,dispatch_status,created_at) values($1,'user',$2,'dispatched',now()-make_interval(mins => $3))",
      [chatId, text, texts.length - index],
    );
  return chatId;
}

function message(page: Page, startsWith: string) {
  return page.getByTestId("user-message").filter({ hasText: startsWith });
}

test.afterAll(async () => {
  await pool.end();
});

test("a long message folds behind Show more and opens in place", async ({ page }) => {
  const chatId = await seedChat([LONG, SHORT]);
  await page.goto(`/chats/${chatId}`);

  const long = message(page, "Create a teammate named Iris");
  const body = long.getByTestId("message-body");
  const toggle = long.getByTestId("message-toggle");
  await expect(toggle).toHaveText("Show more");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(body).toHaveAttribute("data-folded", "true");
  // The fold shows the start and cuts the rest.
  const folded = await body.evaluate((element) => ({
    visible: element.clientHeight,
    full: element.scrollHeight,
  }));
  expect(folded.visible).toBeLessThan(folded.full / 2);

  // A short message has nothing to fold.
  const short = message(page, "Short one:");
  await expect(short.getByTestId("message-body")).not.toHaveAttribute("data-folded");
  await expect(short.getByTestId("message-toggle")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveText("Show less");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).not.toHaveAttribute("data-folded");
  expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  await expect(body.getByText(/Always include source links\./)).toBeInViewport();

  // Folding it again from far below keeps the message in view.
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect(toggle).toHaveText("Show more");
  await expect(body).toHaveAttribute("data-folded", "true");
  await expect(toggle).toBeInViewport();
});

test("a message folds when a narrow window wraps it long", async ({ page }) => {
  const paragraph = Array.from(
    { length: 9 },
    (_, index) => `Sentence ${index + 1} explains one more part of the brief in plain words.`,
  ).join(" ");
  const chatId = await seedChat([paragraph]);
  await page.goto(`/chats/${chatId}`);

  const toggle = message(page, "Sentence 1 explains").getByTestId("message-toggle");
  await expect(toggle).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(toggle).toHaveText("Show more");
});
