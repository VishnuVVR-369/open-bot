import { expect, test } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun, workerApi } from "./helpers";

// Bigger than the 1 MB a Server Action accepts by default.
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

test("attach a file over 1 MB to a message", async ({ page }) => {
  await createTeammate(page, uniqueName("Tess"));
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: `e2e-${Math.random().toString(36).slice(2, 7)}.bin`,
      mimeType: "application/octet-stream",
      buffer: twoMegabytes,
    });
  await expect(page.getByText("2.0 MB")).toBeVisible({ timeout: 30_000 });
});

async function writeFile(path: string, text: string) {
  await workerApi("/internal/files/write", {
    path,
    dataBase64: Buffer.from(text).toString("base64"),
  });
}

async function removeFile(path: string) {
  await workerApi("/internal/files/remove", { path }).catch(() => {});
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
