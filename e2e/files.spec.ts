import { expect, test } from "./fixtures";
import {
  createTeammate,
  sendMessage,
  testSlug,
  uniqueName,
  waitForLastRun,
  worker,
} from "./helpers";

// Bigger than Next.js's 1 MB default body limit, to show the upload route takes the raw bytes.
const twoMegabytes = Buffer.alloc(2 * 1024 * 1024, 7);

test("upload a file to the computer and delete it", async ({ page }) => {
  const name = `e2e-${Math.random().toString(36).slice(2, 7)}.bin`;
  await page.goto("/files");
  await page.getByRole("button", { name: "shared" }).click();
  await page
    .getByTestId("files-input")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: twoMegabytes });
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole("button", { name: `Delete ${name}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});

test("send a message with a file over 1 MB attached", async ({ page }) => {
  await createTeammate(page, uniqueName("Tess"));
  const name = testSlug(`${Math.random().toString(36).slice(2, 7)}.bin`);
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: twoMegabytes,
  });
  await expect(page.getByText("2.0 MB")).toBeVisible({ timeout: 30_000 });

  // The saved attachment comes back from Postgres with its keys in another order, and is still
  // the message that was sent.
  const sent = page.waitForResponse((response) => response.url().includes("/api/rpc/chats/send"));
  await page.getByTestId("composer-input").fill("Here's the file");
  await page.getByTestId("send").click();
  expect((await sent).status()).toBe(200);
  const message = page.getByTestId("user-message").filter({ hasText: "Here's the file" });
  await expect(message.getByText(name)).toBeVisible();
  await expect(page.getByText("Couldn't send")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("");
});

test("send a message with a file again after its answer was lost", async ({ page }) => {
  await createTeammate(page, uniqueName("Tess"));
  const name = testSlug(`${Math.random().toString(36).slice(2, 7)}.txt`);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Flight AB123\n") });
  const chip = page.getByRole("button", { name: `Remove ${name}` });
  await expect(chip).toBeVisible({ timeout: 30_000 });

  // The message is saved, but the connection drops before the answer arrives.
  const saved = new Promise<string>((resolve) => {
    void page.route(
      "**/api/rpc/chats/send",
      async (route) => {
        const response = await route.fetch();
        resolve(String(response.status()));
        await route.abort("connectionreset");
      },
      { times: 1 },
    );
  });
  const text = `Here's my flight ${name}`;
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send").click();
  expect(await saved).toBe("200");
  await expect(page.getByText("Couldn't send")).toBeVisible();
  // The text and the file both come back, so sending again is the same message.
  await expect(page.getByTestId("composer-input")).toHaveValue(text);
  await expect(chip).toBeVisible();

  const again = page.waitForResponse((response) => response.url().includes("/api/rpc/chats/send"));
  await page.getByTestId("send").click();
  expect((await again).status()).toBe(200);
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  await page.reload();
  const message = page.getByTestId("user-message").filter({ hasText: text });
  await expect(message).toHaveCount(1);
  await expect(message.getByText(name, { exact: true })).toBeVisible();
});

async function writeFile(path: string, text: string) {
  await worker.files.write({
    path,
    dataBase64: Buffer.from(text).toString("base64"),
  });
}

async function removeFile(path: string) {
  await worker.files.remove({ path }).catch(() => {});
}

test("preview a table, a note and a missing file", async ({ page }) => {
  const id = Math.random().toString(36).slice(2, 7);
  const table = `/home/bot/shared/e2e-${id}.csv`;
  const note = `/home/bot/shared/e2e-${id}.md`;
  await writeFile(table, 'fruit,count\napple,3\n"pear, green",5\n');
  await writeFile(note, "# Shopping\n\n- **milk**\n- eggs\n");
  try {
    await page.goto("/files");
    await page.getByRole("button", { name: "shared" }).click();

    await page.getByRole("button", { name: `Preview e2e-${id}.csv` }).click();
    const preview = page.getByTestId("file-preview");
    await expect(preview.getByRole("heading", { name: `e2e-${id}.csv` })).toBeVisible();
    await expect(preview.getByRole("columnheader", { name: "fruit" })).toBeVisible();
    await expect(preview.getByRole("cell", { name: "pear, green" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    // The name opens it too.
    await page.getByRole("button", { name: `e2e-${id}.md`, exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Shopping" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("milk");
    await expect(preview.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      `/api/files/download?path=${encodeURIComponent(note)}`,
    );
    await page.keyboard.press("Escape");

    // A file that went away while the list was open says so.
    await removeFile(note);
    await page.getByRole("button", { name: `Preview e2e-${id}.md` }).click();
    await expect(preview).toContainText("This file isn't there anymore");
  } finally {
    await removeFile(table);
    await removeFile(note);
  }
});

test("@agent a file in a reply opens a preview", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const path = `/home/bot/shared/e2e-${Math.random().toString(36).slice(2, 7)}.csv`;
  try {
    await createTeammate(page, uniqueName("Tess"));
    await sendMessage(
      page,
      `Create the file ${path} containing exactly two lines: "fruit,count" and "kiwi,4". Then reply with one sentence that includes the file's full path.`,
    );
    await waitForLastRun(page, ["completed"]);
    const chip = page.getByTestId("file-chip").last();
    await expect(chip).toHaveText(path.split("/").pop()!);
    await chip.click();
    const preview = page.getByTestId("file-preview");
    await expect(preview.getByRole("cell", { name: "kiwi" })).toBeVisible();
    await expect(preview.getByRole("cell", { name: "4" })).toBeVisible();
  } finally {
    await removeFile(path);
  }
});
