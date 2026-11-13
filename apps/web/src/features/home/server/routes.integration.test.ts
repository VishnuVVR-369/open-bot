import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { ids } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("serves Home with the same badges as the shell", async () => {
    const [home, state] = await Promise.all([
      api.home.get({ awaySince: new Date(Date.now() - 3_600_000).toISOString() }),
      api.app.state(),
    ]);
    expect(home.unreadNotifications).toBe(state.unreadNotifications);
    expect(home.pendingApprovals).toBe(state.pendingApprovals);
    expect(home.activity.map((item) => item.runId)).toEqual([ids.run]);
    expect(home.briefing.map((item) => item.automationTitle)).toEqual(["Morning news"]);
  });
});
