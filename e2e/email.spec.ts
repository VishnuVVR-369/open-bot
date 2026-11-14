import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect, test, type Page } from "./fixtures";
import {
  e2eStack,
  apiFor,
  approve,
  teammateIdOf,
  createTeammate,
  suiteLock,
  uniqueName,
  waitForLastRun,
} from "./helpers";

const pool = new pg.Pool({
  connectionString: e2eStack().databaseUrl,
});

test.afterAll(() => pool.end());

/** The domain and Postmark token the tests set up, and the token's hint (`secretHint()`). */
const TEST_DOMAIN = "mail.e2e.test";
const TEST_TOKEN = "e2e-postmark-token-0123456789abcdef";
const TEST_TOKEN_HINT = "e2e…cdef";

/**
 * Your email settings, put back after each test. It holds the email-settings lock until then, so
 * a second run skips instead of noting the first run's settings as yours. Only what the test set
 * is undone: settings you change meanwhile, to another domain or token, stay.
 */
async function keepEmailSettings() {
  const release = await suiteLock(pool, "email settings");
  test.skip(!release, "Another run is testing the email settings on this app.");
  try {
    const settings = await pool.query("select * from email_settings where id = 1");
    const token = await pool.query("select * from credentials where kind = 'postmark_token'");
    /** `postmarkUrl`: the stand-in's address, when the test pointed sending at it. */
    return async (postmarkUrl?: string) => {
      try {
        const row = settings.rows[0] as
          | {
              domain: string | null;
              inbound_token: string;
              api_base_url: string;
              last_received_at: Date | null;
            }
          | undefined;
        if (row) {
          await pool.query(
            "update email_settings set domain = $1, inbound_token = $2, last_received_at = $3 where id = 1 and lower(domain) = $4",
            [row.domain, row.inbound_token, row.last_received_at, TEST_DOMAIN],
          );
          if (postmarkUrl)
            await pool.query(
              "update email_settings set api_base_url = $1 where id = 1 and api_base_url = $2",
              [row.api_base_url, postmarkUrl],
            );
        } else
          await pool.query("delete from email_settings where lower(domain) = $1", [TEST_DOMAIN]);
        // Yours comes back only in place of the test's: if you removed it meanwhile, it stays gone.
        const removed = await pool.query(
          "delete from credentials where kind = 'postmark_token' and hint = $1",
          [TEST_TOKEN_HINT],
        );
        const saved = token.rows[0] as { encrypted: string; hint: string } | undefined;
        if (saved && removed.rowCount)
          await pool.query(
            "insert into credentials (kind, encrypted, hint) values ('postmark_token', $1, $2) on conflict (kind) do nothing",
            [saved.encrypted, saved.hint],
          );
      } finally {
        await release!();
      }
    };
  } catch (error) {
    await release!();
    throw error;
  }
}

async function setUpEmail(page: Page, domain: string) {
  await page.goto("/settings#email");
  const section = page.getByTestId("email-section");
  await section.getByLabel("Domain").fill(domain);
  await section.getByLabel("Postmark server token").fill(TEST_TOKEN);
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
  const postmarkUrl = `http://127.0.0.1:${(postmark.address() as AddressInfo).port}`;
  try {
    const name = uniqueName("Ann");
    await createTeammate(page, name, "executive assistant");
    const teammateId = await teammateIdOf(page, name);
    const section = await setUpEmail(page, "mail.e2e.test");
    await pool.query("update email_settings set api_base_url = $1 where id = 1", [postmarkUrl]);
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
    const state = await apiFor(page).app.state();
    const inbox = state.chats.find(
      (chat) => chat.kind === "inbox" && chat.teammateId === teammateId,
    )!;
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
    await approve(approval);
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
    await restore(postmarkUrl);
  }
});

/** A 1×1 PNG, small enough to send in a test and a real image to the model. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an email's attachments reach the teammate as files open-bot keeps track of", async ({
  page,
}) => {
  const restore = await keepEmailSettings();
  try {
    const name = uniqueName("Ann");
    await createTeammate(page, name);
    const teammateId = await teammateIdOf(page, name);
    const section = await setUpEmail(page, "mail.e2e.test");
    const path = new URL((await section.getByTestId("inbound-url").textContent())!).pathname;
    const notes = Buffer.from("Gate B12, boarding at 09:10\n");
    const delivered = await page.request.post(path, {
      data: {
        ...postmarkEmail(`${name.toLowerCase()}@mail.e2e.test`, {
          subject: "Boarding pass",
          text: "Here's my boarding pass and the gate.",
          id: `boarding-${Date.now()}`,
        }),
        Attachments: [
          {
            Name: "boarding pass.png",
            ContentType: "image/png",
            Content: PIXEL.toString("base64"),
          },
          { Name: "notes.txt", ContentType: "text/plain", Content: notes.toString("base64") },
        ],
      },
    });
    expect(await delivered.json()).toEqual({ ok: true, delivered: true });

    // The run carries them as attachments, so the teammate sees the picture, not just a path.
    const { rows: runs } = await pool.query<{ prompt: string; attachments: { path: string }[] }>(
      "select prompt, attachments from runs where bot_id = $1 and trigger = 'email'",
      [teammateId],
    );
    expect(runs).toHaveLength(1);
    const uploaded = (file: string) =>
      expect.stringMatching(new RegExp(`^/home/bot/shared/uploads/[0-9a-f-]{36}-${file}$`));
    expect(runs[0]!.attachments).toEqual([
      {
        name: "boarding pass.png",
        path: uploaded("boarding pass\\.png"),
        mime: "image/png",
        size: PIXEL.length,
      },
      { name: "notes.txt", path: uploaded("notes\\.txt"), mime: "text/plain", size: notes.length },
    ]);
    expect(runs[0]!.prompt).toContain("Attachments: boarding pass.png, notes.txt");

    // Each is an upload, checked like one and cleaned up like one once nothing uses it.
    const paths = runs[0]!.attachments.map((attachment) => attachment.path);
    const { rows: tracked } = await pool.query(
      "select path, status, sha256 from uploads where path = any($1) order by name",
      [paths],
    );
    const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    expect(tracked).toEqual([
      { path: paths[0], status: "complete", sha256: sha256(PIXEL) },
      { path: paths[1], status: "complete", sha256: sha256(notes) },
    ]);
    const download = await page.request.get(
      `/api/files/download?path=${encodeURIComponent(paths[1]!)}`,
    );
    expect(await download.text()).toBe(notes.toString());
  } finally {
    await restore();
  }
});
