import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { ids, workerPaths, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("passes settings and email changes to the worker, which owns them, and its refusals through", async () => {
    const ok = { status: 200, body: { ok: true } };
    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";
    const email = { domain: "team.example.test", token: "0123456789abcdef-0123456789" };
    const calls: [string, () => Promise<unknown>, unknown][] = [
      [
        "/internal/settings/timezone",
        () => api.settings.setTimezone({ timezone: "Asia/Tokyo" }),
        { timezone: "Asia/Tokyo" },
      ],
      [
        "/internal/settings/api-key",
        () => api.settings.saveApiKey({ apiKey: ` ${apiKey} ` }),
        { apiKey },
      ],
      ["/internal/settings/api-key/delete", () => api.settings.removeApiKey(), undefined],
      [
        "/internal/settings/monthly-cap",
        () => api.settings.setMonthlyCap({ dollars: 25.5 }),
        { dollars: 25.5 },
      ],
      ["/internal/email", () => api.email.save(email), email],
      ["/internal/email/token/delete", () => api.email.removeToken(), undefined],
    ];
    const sync = `/internal/bots/${ids.teammate}/sync`; // vocabulary: allow
    for (const [path] of calls) answers.set(path, ok);
    answers.set(sync, ok);
    try {
      for (const [path, call, body] of calls) {
        const before = workerBodies.length;
        expect(await call()).toEqual({ ok: true });
        expect(workerBodies.slice(before).find((b) => b.path === path)).toEqual({ path, body });
      }
      // Saved email settings reach each teammate's instructions.
      expect(workerPaths).toContain(sync);

      answers.set("/internal/settings/timezone", {
        status: 400,
        body: { error: "Unknown timezone.", code: "BAD_REQUEST" },
      });
      await expect(api.settings.setTimezone({ timezone: "Mars/Olympus" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Unknown timezone.",
      });
      // The contract refuses input before it reaches the worker.
      const before = workerBodies.length;
      await expect(api.settings.saveApiKey({ apiKey: "pk-123" })).rejects.toMatchObject({
        message: "That doesn't look like an OpenAI API key. It starts with sk-.",
      });
      await expect(api.settings.setMonthlyCap({ dollars: Number.NaN })).rejects.toMatchObject({
        message: "Give the cap in dollars, like 50.",
      });
      expect(workerBodies.length).toBe(before);
    } finally {
      for (const [path] of calls) answers.delete(path);
      answers.delete(sync);
    }
  });
});
