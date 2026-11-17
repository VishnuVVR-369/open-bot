import { describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

describe.skipIf(!apiTestUrl)("web before the automation migration", () => {
  const h = apiHarness();
  it("reads chats, Home and automation history against the previous schema", async () => {
    // This suite owns its database. Reproduce web deploying before the worker's migration.
    await h.database.pool.query(
      "alter table runs drop column lane, drop column quiet, drop column passed_on_at",
    );
    await h.database.pool.query("drop table chat_lane_threads");
    const api = h.api;
    expect((await api.chats.list()).find((chat) => chat.id === h.ids.chat)).toBeDefined();
    const chat = await api.chats.get({ chatId: h.ids.chat });
    expect(chat).toBeDefined();
    const home = await api.home.get({ awaySince: new Date(Date.now() - 3_600_000).toISOString() });
    expect(home.activity[0]!.runId).toBe(h.ids.run);
    expect(home.briefing[0]!.runId).toBe(h.ids.run);
    expect(await api.schedules.list()).toHaveLength(1);
    expect(await api.triggers.list()).toHaveLength(1);
    // The full-run reads are separate from the list summaries.
    expect(await api.schedules.runs({ scheduleId: h.ids.schedule })).toHaveLength(1);
  });
});
