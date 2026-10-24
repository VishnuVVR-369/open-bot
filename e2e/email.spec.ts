import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import { botIdOf, createTeammate, uniqueName, waitForLastRun } from "./helpers";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
});

test.afterAll(() => pool.end());

/** Your email settings, put back as they were after each test. */
async function keepEmailSettings() {
  const settings = await pool.query("select * from email_settings where id = 1");
  const token = await pool.query("select * from credentials where kind = 'postmark_token'");
  return async () => {
    const row = settings.rows[0] as
      | {
          domain: string | null;
          inbound_token: string;
          api_base_url: string;
          last_received_at: Date | null;
        }
      | undefined;
    if (row)
      await pool.query(
        "update email_settings set domain = $1, inbound_token = $2, api_base_url = $3, last_received_at = $4 where id = 1",
        [row.domain, row.inbound_token, row.api_base_url, row.last_received_at],
      );
    else await pool.query("delete from email_settings");
    await pool.query("delete from credentials where kind = 'postmark_token'");
    const saved = token.rows[0] as { encrypted: string; hint: string } | undefined;
    if (saved)
      await pool.query(
        "insert into credentials (kind, encrypted, hint) values ('postmark_token', $1, $2)",
        [saved.encrypted, saved.hint],
      );
  };
}

async function setUpEmail(page: Page, domain: string) {
  await page.goto("/settings#email");
  const section = page.getByTestId("email-section");
  await section.getByLabel("Domain").fill(domain);
  await section.getByLabel("Postmark server token").fill("e2e-postmark-token-0123456789abcdef");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByLabel("Postmark server token")).toHaveAttribute(
    "placeholder",
    /Saved: e2e/,
  );
  return section;
}

function postmarkEmail(to: string, input: { subject: string; text: string; id: string }) {
  return {
    From: "Dana Smith <dana@example.com>",
    FromFull: { Email: "dana@example.com", Name: "Dana Smith" },
    To: to,
    ToFull: [{ Email: to, Name: "" }],
    Subject: input.subject,
    TextBody: input.text,
    MessageID: input.id,
    Headers: [{ Name: "Message-ID", Value: `<${input.id}@mail.example.com>` }],
    Attachments: [],
  };
}

test("give every teammate an email address", async ({ page }) => {
  const restore = await keepEmailSettings();
  try {
    const name = uniqueName("Ann");
    await createTeammate(page, name);
    const section = await setUpEmail(page, "Mail.E2E.test");
    const slug = name.toLowerCase();
    await expect(section.getByTestId("email-address").filter({ hasText: name })).toContainText(
      `${slug}@mail.e2e.test`,
    );

    // The inbound webhook takes mail only with its secret, and drops mail for no one.
    const inbound = await section.getByTestId("inbound-url").textContent();
    const path = new URL(inbound!).pathname;
    expect(
      (await page.request.post(path.replace(/[\w-]+$/, "x".repeat(24)), { data: {} })).status(),
    ).toBe(404);
    const nobody = await page.request.post(path, {
      data: postmarkEmail("nobody@mail.e2e.test", { subject: "Hi", text: "Hello", id: "n1" }),
    });
    expect(await nobody.json()).toEqual({ ok: true, delivered: false });
    const elsewhere = await page.request.post(path, {
      data: postmarkEmail(`${slug}@other.test`, { subject: "Hi", text: "Hello", id: "n2" }),
    });
    expect(await elsewhere.json()).toEqual({ ok: true, delivered: false });
  } finally {
    await restore();
  }
});

test("@agent a teammate answers an email from its own address, after you approve", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  const restore = await keepEmailSettings();
  // A stand-in for Postmark's API, which records what teammates send.
  const sent: { body: Record<string, unknown>; token: string }[] = [];
  const postmark = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    sent.push({
      body: JSON.parse(body) as Record<string, unknown>,
      token: String(request.headers["x-postmark-server-token"] ?? ""),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "sent-1" }));
  });
  await new Promise<void>((resolve) => postmark.listen(0, "127.0.0.1", resolve));
  try {
    const name = uniqueName("Ann");
    await createTeammate(page, name, "executive assistant");
    const botId = await botIdOf(page, name);
    const section = await setUpEmail(page, "mail.e2e.test");
    await pool.query("update email_settings set api_base_url = $1 where id = 1", [
      `http://127.0.0.1:${(postmark.address() as AddressInfo).port}`,
    ]);
    const path = new URL((await section.getByTestId("inbound-url").textContent())!).pathname;

    const address = `${name.toLowerCase()}@mail.e2e.test`;
    const delivered = await page.request.post(path, {
      data: postmarkEmail(address, {
        subject: "Lunch on Friday?",
        text: "Hi! Can you confirm lunch with Vishnu on Friday at 1pm? Just reply to confirm. Dana",
        id: "lunch-1",
      }),
    });
    expect(await delivered.json()).toEqual({ ok: true, delivered: true });

    // It arrives in the teammate's Email chat, and the reply waits for your approval.
    const state = (await (await page.request.get("/api/state")).json()) as {
      chats: { id: string; kind: string; botId: string | null }[];
    };
    const inbox = state.chats.find((chat) => chat.kind === "inbox" && chat.botId === botId)!;
    await page.goto(`/chats/${inbox.id}`);
    await expect(page.getByRole("heading", { name: `${name} · Email` })).toBeVisible();
    await expect(page.getByTestId("run").first().getByTestId("run-trigger")).toHaveText("An email");
    // The reply waits in the outbox for your approval, and goes the moment you give it.
    const approval = page
      .getByTestId("approval-card")
      .filter({ hasText: "Email dana@example.com" });
    await expect(approval).toBeVisible({ timeout: 4 * 60_000 });
    await expect(approval.locator("svg.lucide-mail")).toBeVisible();
    await expect(approval.getByRole("button", { name: /Always allow/ })).toHaveCount(0);
    expect(sent).toHaveLength(0);
    await approval.getByTestId("approve").click();
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1);
    await waitForLastRun(page, ["completed"]);
    await expect(page.getByText(`Emailed dana@example.com`).first()).toBeVisible();

    // It went from the teammate's address, threaded under Dana's email.
    const [email] = sent;
    expect(email!.token).toBe("e2e-postmark-token-0123456789abcdef");
    expect(email!.body.From).toBe(`${name} <${address}>`);
    expect(String(email!.body.To)).toContain("dana@example.com");
    expect(email!.body.Headers).toContainEqual({
      Name: "In-Reply-To",
      Value: "<lunch-1@mail.example.com>",
    });
  } finally {
    postmark.close();
    await restore();
  }
});
