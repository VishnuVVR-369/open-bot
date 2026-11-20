import { eq } from "drizzle-orm";
import { notifications, runs } from "@open-bot/db"; // vocabulary: allow
import { describe, expect, it, vi } from "vitest";
import { rpcEnabled, rpcHarness } from "../testing/rpc";
import { complete, type FinalizeSession } from "./session/finalize";

describe.skipIf(!rpcEnabled)("quiet completion with Postgres", () => {
  const h = rpcHarness();
  it.each([
    ["completed", true, true],
    ["completed", false, false],
    ["failed", true, false],
  ] as const)("persists %s quiet=%s as quiet=%s", async (status, scheduleQuiet, expectedQuiet) => {
    const { created, run } = await h.teammateWithRun();
    const schedule = await h.schedules.create({
      teammateId: created.id,
      title: "Check",
      prompt: "Check", // vocabulary: allow
      cron: "0 9 * * *",
      at: null,
      timezone: "UTC",
      quiet: scheduleQuiet,
      createdBy: "user",
    });
    const [row] = await h.db
      .update(runs)
      .set({
        scheduleId: schedule.id,
        trigger: "schedule",
        lane: `schedule:${schedule.id}`,
      })
      .where(eq(runs.id, run.id))
      .returning();
    const touchChat = vi.fn(async () => {});
    const session = {
      ctx: { ...h.ctx, computer: { releaseRun: async () => {} } },
      run: row!,
      bot: { id: created.id, name: "Scout" }, // vocabulary: allow
      chat: { id: created.chatId }, // vocabulary: allow
      finish: null,
      cancelled: false,
      items: new Map([
        [
          "reply",
          {
            id: "reply",
            kind: "message",
            phase: "final",
            text: "Nothing to report.",
            status: "completed",
            startedAt: new Date().toISOString(),
          },
        ],
      ]),
      writer: { write: vi.fn(), drain: async () => {} },
      usage: {
        plan: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        api_key: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      },
      threadIds: new Set<string>(),
      services: { touchChat },
      now: () => new Date().toISOString(),
      putItem: vi.fn(),
      publishedPageId: () => null,
    } as unknown as FinalizeSession;
    await complete(session, { status, ...(status === "failed" ? { error: "Disconnected" } : {}) });
    const [finished] = await h.db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished).toMatchObject({ status, quiet: expectedQuiet });
    expect(touchChat).toHaveBeenCalledTimes(expectedQuiet ? 0 : 1);
    const sent = await h.db.select().from(notifications).where(eq(notifications.runId, run.id));
    expect(sent).toHaveLength(expectedQuiet ? 0 : 1);
    if (status === "failed") expect(sent[0]!.kind).toBe("run_failed");
  });
});
