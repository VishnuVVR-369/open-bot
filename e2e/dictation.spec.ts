import { expect, test, type Page } from "./fixtures";
import { createTeammate, sendMessage, uniqueName, waitForLastRun } from "./helpers";

interface Speech {
  hear: (text: string, isFinal: boolean) => void;
  fail: (error: string) => void;
}

/** What the microphone picks up, as the stand-in reports it. */
async function hear(page: Page, text: string, isFinal: boolean) {
  await page.evaluate(([words, final]) => (window as unknown as Speech).hear(words, final), [
    text,
    isFinal,
  ] as const);
}

/** A stand-in for the browser's speech recognition that "hears" what the test says. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      private results: { isFinal: boolean; 0: { transcript: string } }[] = [];
      start() {
        (window as unknown as { hear: unknown }).hear = (text: string, isFinal: boolean) => {
          const last = this.results.at(-1);
          if (last && !last.isFinal) this.results.pop();
          this.results.push({ isFinal, 0: { transcript: text } });
          this.onresult?.({ resultIndex: 0, results: this.results });
        };
        (window as unknown as { fail: unknown }).fail = (error: string) => {
          this.onerror?.({ error });
          this.onend?.();
        };
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    Object.assign(window, {
      SpeechRecognition: FakeRecognition,
      webkitSpeechRecognition: FakeRecognition,
    });
  });
});

test("dictate a message", async ({ page }) => {
  await createTeammate(page, uniqueName("Tess"));
  const input = page.getByTestId("composer-input");
  await input.fill("Hi.");
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("button", { name: "Stop dictating" })).toBeVisible();

  await hear(page, "check the", false);
  await expect(input).toHaveValue("Hi. check the");
  await hear(page, "check the weather", true);
  await hear(page, " in Ber", false);
  await expect(input).toHaveValue("Hi. check the weather in Ber");

  // Stopping keeps what was recognized and drops the unfinished words.
  await page.getByRole("button", { name: "Stop dictating" }).click();
  await expect(input).toHaveValue("Hi. check the weather");
  await expect(page.getByRole("button", { name: "Dictate" })).toBeVisible();
});

test("dictation explains a blocked microphone", async ({ page }) => {
  await createTeammate(page, uniqueName("Tess"));
  await page.getByRole("button", { name: "Dictate" }).click();
  await page.evaluate(() => (window as unknown as Speech).fail("not-allowed"));
  await expect(page.getByText("Allow the microphone for this site to dictate.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dictate" })).toBeVisible();
});

test("@agent read a reply aloud", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  // A stand-in for the browser's voices that remembers what it was asked to say.
  await page.addInitScript(() => {
    const said: string[] = [];
    let current: { onend: (() => void) | null } | null = null;
    Object.assign(window, { said, finishSpeaking: () => current?.onend?.() });
    // A read-only property of the window, so it's replaced rather than assigned.
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: (utterance: { text: string; onend: (() => void) | null }) => {
          said.push(utterance.text);
          current = utterance;
        },
        cancel: () => {},
      },
    });
  });
  await createTeammate(page, uniqueName("Tess"));
  await sendMessage(page, "Reply with exactly these two lines: 'First line' and 'Second line'.");
  await waitForLastRun(page, ["completed"]);

  const run = page.getByTestId("run").last();
  await run.hover();
  await run.getByRole("button", { name: "Read aloud" }).click();
  await expect(run.getByRole("button", { name: "Stop reading" })).toBeVisible();
  const said = await page.evaluate(() => (window as unknown as { said: string[] }).said);
  expect(said.at(-1)).toMatch(/First line\.? Second line/);

  await page.evaluate(() => (window as unknown as { finishSpeaking: () => void }).finishSpeaking());
  await run.hover();
  await expect(run.getByRole("button", { name: "Read aloud" })).toBeVisible();
});
