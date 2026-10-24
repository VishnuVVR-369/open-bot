import { expect, test, type Page } from "./fixtures";
import { createTeammate, uniqueName, waitForLastRun, workerApi } from "./helpers";
import { MOCK_BOT, MOCK_TOKEN, TelegramMock, USER } from "./telegram-mock";

const MOCK_PORT = 4797;

/** Wait until `find` returns something, and return it. */
async function eventually<T>(find: () => T | undefined, timeout = 240_000): Promise<T> {
  let found: T | undefined;
  await expect.poll(() => (found = find()) !== undefined, { timeout }).toBe(true);
  return found!;
}

test("Telegram setup explains the steps and checks the token", async ({ page }) => {
  const status = await workerApi<{ connected: boolean }>("/internal/telegram");
  test.skip(status.connected, "A Telegram bot is connected; leave it alone.");
  await page.goto("/settings#telegram");
  const section = page.locator("#telegram");
  await expect(section).toContainText("Make a Telegram bot");
  await expect(section.getByRole("link", { name: "@BotFather" })).toHaveAttribute(
    "href",
    "https://t.me/BotFather",
  );
  await section.getByTestId("telegram-token").fill("not a token");
  await section.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("That doesn't look like a bot token.")).toBeVisible();
});

/**
 * These play your phone against a stand-in for Telegram. Start the worker pointed at it first:
 *   TELEGRAM_API_BASE_URL=http://127.0.0.1:4797 pnpm --filter @open-bot/worker dev
 * then run with E2E_TELEGRAM=1.
 */
test.describe("Telegram, against a stand-in", () => {
  test.skip(!process.env.E2E_TELEGRAM, "Set E2E_TELEGRAM=1 with the worker pointed at the mock.");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(6 * 60_000);

  const telegram = new TelegramMock();
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    await telegram.start(MOCK_PORT);
    page = await browser.newPage({ storageState: "e2e/.auth/owner.json" });
  });

  test.afterAll(async () => {
    await workerApi("/internal/telegram/disconnect", {}).catch(() => {});
    await page.close();
    await telegram.stop();
  });

  test("connect a bot and link your account with a code", async () => {
    await page.goto("/settings#telegram");
    const section = page.locator("#telegram");
    await section.getByTestId("telegram-token").fill(MOCK_TOKEN);
    await section.getByRole("button", { name: "Connect" }).click();
    await expect(section).toContainText(`Connected @${MOCK_BOT}`);

    // Someone who isn't linked gets turned away.
    telegram.say("hello?", { id: 999, first_name: "Stranger" });
    await expect.poll(() => telegram.texts(999).join("\n")).toContain("private assistant");

    await section.getByRole("button", { name: "Get a link code" }).click();
    const code = (await section.getByTestId("telegram-link-code").textContent())!.replace(
      "/start ",
      "",
    );
    telegram.say(`/start WRONGCODE`);
    await expect.poll(() => telegram.texts().join("\n")).toContain("isn't valid anymore");
    telegram.say(`/start ${code}`);
    await expect(section.getByTestId("telegram-linked")).toHaveText(`Linked to @${USER.username}`);
    await expect.poll(() => telegram.texts().join("\n")).toContain("Linked.");

    await section.getByRole("button", { name: "Send a test" }).click();
    await expect.poll(() => telegram.texts().join("\n")).toContain("open-bot is connected");
    telegram.say("/team");
    await expect.poll(() => telegram.texts().at(-1)).toMatch(/·/);
  });

  test("@agent message a teammate by name and get the reply in Telegram", async () => {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const sentAt = telegram.say(`${name}: Reply with only the word pineapple.`);
    // The message shows up in the app's chat too.
    await expect(page.getByText("Reply with only the word pineapple.")).toBeVisible();
    await expect
      .poll(() => telegram.sent.some((m) => m.method === "setMessageReaction"))
      .toBe(true);
    await waitForLastRun(page, ["completed"]);
    await eventually(() =>
      telegram.sent.find(
        (m) =>
          m.method === "sendMessage" &&
          String(m.params.text).toLowerCase().includes("pineapple") &&
          (m.params.reply_parameters as { message_id?: number } | undefined)?.message_id === sentAt,
      ),
    );

    // Without a name, the next message goes to the same teammate.
    telegram.say("Now reply with only the word mango.");
    await expect(page.getByText("Now reply with only the word mango.")).toBeVisible();
    await expect
      .poll(() => telegram.texts().join("\n").toLowerCase(), { timeout: 240_000 })
      .toContain("mango");
  });

  test("@agent approve a teammate's action with a button", async () => {
    const name = uniqueName("Ora");
    await createTeammate(page, name, "file clerk");
    telegram.say(
      `${name}: Ask my approval to create the file /home/bot/shared/e2e-telegram.txt, then create it with the text 'hi' and delete it again.`,
    );
    const approval = await eventually(() =>
      telegram.sent.find(
        (m) =>
          m.method === "sendMessage" &&
          JSON.stringify(m.params.reply_markup ?? "").includes('"Approve"'),
      ),
    );
    const markup = approval.params.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    telegram.press(markup.inline_keyboard[0]![0]!.callback_data, approval.message_id);
    await expect
      .poll(() =>
        telegram.sent.some(
          (m) =>
            m.method === "editMessageReplyMarkup" &&
            JSON.stringify(m.params.reply_markup).includes("Approved"),
        ),
      )
      .toBe(true);
    await waitForLastRun(page, ["completed"]);
  });
});
