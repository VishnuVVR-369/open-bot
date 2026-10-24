import { expect, test as base } from "@playwright/test";

/**
 * Every test's page fails it on React hydration errors, which otherwise only show as a badge in
 * development and make React re-render the whole page in the browser.
 */
export const test = base.extend<{ hydrationGuard: void }>({
  hydrationGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const check = (text: string) => {
        if (/Hydration failed|hydrated but some attributes|didn't match the client/i.test(text))
          problems.push(text.split("\n")[0]!);
      };
      page.on("console", (message) => {
        if (message.type() === "error") check(message.text());
      });
      page.on("pageerror", (error) => check(error.message));
      await use();
      expect(problems, "React hydration errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from "@playwright/test";
