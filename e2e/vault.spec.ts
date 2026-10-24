import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "./fixtures";
import { botIdOf, createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

const botd = process.env.BOTD_URL ?? "http://127.0.0.1:7070";
const botdToken = process.env.BOTD_TOKEN ?? "dev-botd-token-change-me";

async function botdPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${botd}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botdToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

async function addLogin(
  page: Page,
  input: { name: string; site: string; username: string; password: string },
) {
  await page.goto("/vault");
  await page.getByTestId("vault-logins").getByRole("button", { name: "Add login" }).click();
  const dialog = page.getByTestId("vault-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(input.name);
  await dialog.getByLabel("Site").fill(input.site);
  await dialog.getByLabel("Username or email").fill(input.username);
  await dialog.getByLabel("Password").fill(input.password);
  await dialog.getByTestId("vault-save").click();
  await expect(dialog).toHaveCount(0);
}

test("keep logins and cards in the vault without showing them again", async ({ page }) => {
  const marker = uniqueName("Tess");
  const login = `E2E GitHub ${marker}`;
  const card = `E2E Visa ${marker}`;
  const password = `pw-${marker}-secret`;
  await addLogin(page, {
    name: login,
    site: "https://www.github.com/login",
    username: "octo@example.com",
    password,
  });
  const loginRow = page.getByTestId("vault-item").filter({ hasText: login });
  await expect(loginRow).toContainText("octo@example.com");
  await expect(loginRow).toContainText("github.com");
  await expect(loginRow).toContainText("Every teammate");

  // A card, with its number checked.
  await page.getByTestId("vault-cards").getByRole("button", { name: "Add card" }).click();
  const dialog = page.getByTestId("vault-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(card);
  await dialog.getByLabel("Card number").fill("4242424242424241");
  await dialog.getByLabel("Expiry").fill("0830");
  await dialog.getByLabel("Security code").fill("123");
  await dialog.getByLabel("Name on the card").fill("Test Owner");
  await dialog.getByTestId("vault-save").click();
  await expect(page.getByText("That card number isn't valid.")).toBeVisible();
  await dialog.getByLabel("Card number").fill("4242424242424242");
  await expect(dialog.getByLabel("Card number")).toHaveValue("4242 4242 4242 4242");
  await dialog.getByTestId("vault-save").click();
  await expect(dialog).toHaveCount(0);
  const cardRow = page.getByTestId("vault-item").filter({ hasText: card });
  await expect(cardRow).toContainText("Visa •••• 4242");

  // Nothing secret comes back to the browser.
  const listed = await (await page.request.get("/api/vault")).text();
  expect(listed).not.toContain(password);
  expect(listed).not.toContain("4242424242424242");

  // Editing keeps the saved password, and can limit who uses it.
  const owner = uniqueName("Ivy");
  await createTeammate(page, owner);
  await page.goto("/vault");
  await loginRow.hover();
  await page.getByRole("button", { name: `Edit ${login}` }).click();
  await expect(dialog.getByLabel("Password")).toHaveValue("");
  await dialog.getByRole("switch", { name: "Every teammate can use it" }).click();
  await dialog.getByRole("button", { name: owner }).click();
  await dialog.getByTestId("vault-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(loginRow).toContainText(`Only ${owner}`);

  // Deleting removes it.
  await cardRow.hover();
  await page.getByRole("button", { name: `Delete ${card}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(cardRow).toHaveCount(0);
});

test("give a teammate a monthly budget", async ({ page }) => {
  const name = uniqueName("Ava");
  await createTeammate(page, name);
  const botId = await botIdOf(page, name);
  await page.goto(`/bots/${botId}?tab=spending`);
  const budget = page.getByTestId("budget");
  await budget.getByRole("switch", { name: `${name} can pay for things` }).click();
  await budget.getByLabel("Monthly budget").fill("50");
  await budget.getByLabel("Approve on its own up to").fill("80");
  await budget.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByText("can't be more than the budget")).toBeVisible();
  await budget.getByLabel("Approve on its own up to").fill("10");
  await budget.getByRole("button", { name: "Save budget" }).click();
  await expect(budget.getByRole("button", { name: "Save budget" })).toHaveCount(0);
  await expect(page.getByTestId("spent")).toContainText("$0 of $50");
  await expect(budget).toContainText(`No card ${name} may use yet`);

  await page.reload();
  await expect(page.getByLabel("Monthly budget")).toHaveValue("50");
  await expect(page.getByLabel("Approve on its own up to")).toHaveValue("10");
});

test("the computer types a saved password only on its own site", async ({ page }) => {
  // A sign-in page that reports what was typed into it.
  const submitted: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/done") submitted.push(url.searchParams.get("password") ?? "");
    response.setHeader("content-type", "text/html");
    response.end(`<form action="/done"><input name="password" type="password" autofocus></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const site = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
  const name = uniqueName("Ben");
  await createTeammate(page, name);
  const botId = await botIdOf(page, name);
  const run = { runId: `e2e-${botId}`, botId, botName: "E2E" };
  try {
    await botdPost("/computer/action", { run, action: { action: "open_url", url: `${site}/` } });

    // Another site's login isn't typed here.
    expect(
      await botdPost("/computer/fill", { run, secret: "not-for-you", site: "github.com" }),
    ).toMatchObject({ ok: false, code: "wrong_site" });

    // This site's is, into the focused field.
    const filled = await botdPost<{ ok: boolean; pages: string[] }>("/computer/fill", {
      run,
      secret: "s3cret pass!",
      site: "host.docker.internal",
    });
    expect(filled.ok).toBe(true);
    expect(filled.pages[0]).toContain("host.docker.internal");
    await botdPost("/computer/action", { run, action: { action: "key", keys: "Enter" } });
    await expect.poll(() => submitted).toEqual(["s3cret pass!"]);
  } finally {
    await botdPost("/lease/run/release", { runId: run.runId });
    server.close();
  }
});

/** A small shop: sign in, then pay for tea with a card. It records what it was sent. */
function teaShop(account: { username: string; password: string }, card: string) {
  const seen = { logins: [] as string[], payments: [] as string[] };
  const page = (body: string) =>
    `<!doctype html><html><head><title>Tea shop</title><style>body{font:18px system-ui;margin:40px}input{display:block;font:18px system-ui;margin:6px 0 16px;padding:8px;width:360px}button{font:18px system-ui;padding:10px 18px}</style></head><body>${body}</body></html>`;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://shop");
    let body = "";
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    const signedIn = /shop_session=ok/.test(request.headers.cookie ?? "");
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/login" && request.method === "POST") {
      seen.logins.push(`${form.get("username")}:${form.get("password")}`);
      if (form.get("username") === account.username && form.get("password") === account.password) {
        response.writeHead(303, { "set-cookie": "shop_session=ok; Path=/", location: "/shop" });
        response.end();
      } else
        response.end(page(`<h1>Wrong username or password</h1><a href="/login">Try again</a>`));
      return;
    }
    if (url.pathname === "/login") {
      response.end(
        page(
          `<h1>Sign in to the tea shop</h1><form method="post" action="/login"><label>Email<input name="username" autocomplete="off"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`,
        ),
      );
      return;
    }
    if (!signedIn) {
      response.end(page(`<h1>Please <a href="/login">sign in</a> first</h1>`));
      return;
    }
    if (url.pathname === "/pay" && request.method === "POST") {
      const number = (form.get("number") ?? "").replace(/\s/g, "");
      seen.payments.push(`${number}|${form.get("expiry")}|${form.get("cvc")}`);
      response.end(
        page(
          number === card && form.get("cvc") === "737"
            ? `<h1>Order TEA-4821 confirmed</h1><p>Oolong tea, $12.00. Thank you!</p>`
            : `<h1>Payment declined</h1><p>Check the card details.</p><a href="/shop">Back</a>`,
        ),
      );
      return;
    }
    response.end(
      page(
        `<p>Signed in as ${account.username}</p><h1>Oolong tea, 250 g: $12.00</h1><form method="post" action="/pay"><label>Card number<input name="number" autocomplete="off"></label><label>Expiry (MM/YY)<input name="expiry" autocomplete="off"></label><label>Security code<input name="cvc" autocomplete="off"></label><label>Name on card<input name="name" autocomplete="off"></label><button>Pay $12.00</button></form>`,
      ),
    );
  });
  return {
    seen,
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "0.0.0.0", () =>
          resolve(`http://host.docker.internal:${(server.address() as AddressInfo).port}`),
        ),
      ),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("@agent a teammate signs in and pays from the vault without seeing either", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const marker = uniqueName("Tess");
  const account = { username: `${marker}@example.com`, password: `Pw-${marker}-9!x` };
  const card = "5555555555554444";
  const shop = teaShop(account, card);
  const site = await shop.start();
  try {
    await addLogin(page, {
      name: `E2E Tea shop ${marker}`,
      site: "host.docker.internal",
      ...account,
    });
    await page.getByTestId("vault-cards").getByRole("button", { name: "Add card" }).click();
    const dialog = page.getByTestId("vault-dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(`E2E Mastercard ${marker}`);
    await dialog.getByLabel("Card number").fill(card);
    await dialog.getByLabel("Expiry").fill("1129");
    await dialog.getByLabel("Security code").fill("737");
    await dialog.getByLabel("Name on the card").fill("Tess Owner");
    await dialog.getByTestId("vault-save").click();
    await expect(dialog).toHaveCount(0);

    // A budget that covers the tea, which is over what it may spend without asking.
    const name = uniqueName("Ora");
    await createTeammate(page, name, "shopper");
    const botId = await botIdOf(page, name);
    await page.goto(`/bots/${botId}?tab=spending`);
    const budget = page.getByTestId("budget");
    await budget.getByRole("switch", { name: `${name} can pay for things` }).click();
    await budget.getByLabel("Monthly budget").fill("40");
    await budget.getByLabel("Approve on its own up to").fill("5");
    await budget.getByRole("button", { name: "Save budget" }).click();
    await expect(budget.getByRole("button", { name: "Save budget" })).toHaveCount(0);

    await page
      .getByRole("link", { name: new RegExp(`^${name}`) })
      .first()
      .click();
    await page.waitForURL(/\/chats\//);
    await sendMessage(
      page,
      `Sign in at ${site}/login with the login saved in your vault, then buy the oolong tea at ${site}/shop with the card saved in your vault. Reply with the order number.`,
    );

    // It asks before paying, since $12 is over what it may spend on its own.
    const approval = page.getByTestId("approval-card");
    await expect(approval).toContainText("Pay $12", { timeout: 5 * 60_000 });
    await approval.getByTestId("approve").click();
    await waitForLastRun(page, ["completed"], 5 * 60_000);
    await expect(page.getByTestId("run").last()).toContainText("TEA-4821");

    // The shop got the right details, typed on the screen.
    expect(shop.seen.logins).toContain(`${account.username}:${account.password}`);
    expect(shop.seen.payments.some((payment) => payment.startsWith(`${card}|11/29|737`))).toBe(
      true,
    );

    // Neither secret went through the teammate: nothing it saw or said contains them.
    const chat = await (
      await page.request.get(page.url().replace(/\/chats\//, "/api/chats/"))
    ).text();
    expect(chat).not.toContain(account.password);
    expect(chat).not.toContain(card);
    expect(chat).not.toContain("5555 5555 5555 4444");

    // The purchase counts against its budget.
    await page.goto(`/bots/${botId}?tab=spending`);
    await expect(page.getByTestId("purchase").first()).toContainText("$12");
    await expect(page.getByTestId("purchase").first()).toContainText("Paid");
    await expect(page.getByTestId("spent")).toContainText("$12 of $40");
  } finally {
    await shop.stop();
  }
});
