import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import {
  bots as teammates, // vocabulary: allow
  chats,
  runs,
  schedules,
  type RunLane,
} from "@open-bot/db";
import { LANE_NEWS_LENGTH, LANE_NEWS_LIMIT, laneNews } from "./lane-news";

const url = testDatabaseServer();

/** What a teammate's conversation hears about the work its other lanes finished in the chat. */
describe.skipIf(!url)("lane news with Postgres", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  let teammateId: string;
  let chatId: string;
  let scheduleId: string;
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const time = (at: Date) => `at ${at.toISOString()}`;

  beforeAll(async () => {
    await database.create();
  });
  beforeEach(async () => {
    await pool.query("truncate bots, chats restart identity cascade"); // vocabulary: allow
    const [teammate] = await db
      .insert(teammates)
      .values({ name: "Rex", slug: "rex", role: "assistant", color: "#4f46e5" })
      .returning();
    teammateId = teammate!.id;
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: "Rex", botId: teammateId, main: true }) // vocabulary: allow
      .returning();
    chatId = chat!.id;
    const [schedule] = await db
      .insert(schedules)
      .values({
        botId: teammateId, // vocabulary: allow
        title: "Morning briefing",
        prompt: "Brief me",
        kind: "cron",
        cron: "0 8 * * *",
        timezone: "UTC",
        createdBy: "user",
      })
      .returning();
    scheduleId = schedule!.id;
  });
  afterAll(async () => {
    await database.drop();
  });

  async function run(values: {
    lane: RunLane;
    startedAt?: Date | null;
    completedAt?: Date | null;
    status?: "queued" | "completed" | "failed";
    finalText?: string | null;
    error?: string | null;
    quiet?: boolean;
    readOutsideData?: boolean;
    scheduleId?: string | null;
    codexTurnId?: string | null;
  }) {
    const [row] = await db
      .insert(runs)
      .values({
        chatId,
        botId: teammateId, // vocabulary: allow
        trigger: values.lane === "chat" ? "user" : "schedule",
        prompt: "Go",
        status: "completed",
        ...values,
      })
      .returning();
    return row!;
  }

  /** The conversation's run that has just started, and is about to take its turn. */
  const conversation = (startedAt = new Date()) =>
    run({ lane: "chat", status: "queued", startedAt, completedAt: null });
  /** A turn of the conversation that Codex took. */
  const turn = (started: number) =>
    run({
      lane: "chat",
      startedAt: minutesAgo(started),
      completedAt: minutesAgo(started - 1),
      codexTurnId: `turn-${started}`,
    });

  it("passes on what other lanes finished since the conversation's last turn", async () => {
    await run({
      lane: "inbox",
      completedAt: minutesAgo(50),
      finalText: "Old email, heard already",
    });
    await turn(40);
    await run({
      lane: `schedule:${scheduleId}`,
      scheduleId,
      completedAt: minutesAgo(30),
      finalText: "Three meetings today.",
    });
    await run({ lane: "inbox", status: "failed", completedAt: minutesAgo(20), error: "No access" });
    await run({
      lane: `schedule:${scheduleId}`,
      scheduleId,
      completedAt: minutesAgo(10),
      quiet: true,
    });
    const current = await conversation();

    const news = await laneNews(db, current, time);
    expect(news!.readOutsideData).toBe(false);
    expect(news!.text).toContain('Your routine "Morning briefing", at ');
    expect(news!.text).toContain("  Three meetings today.");
    expect(news!.text).toContain("An email you received");
    expect(news!.text).toContain("It failed: No access");
    expect(news!.text).not.toContain("Old email");
    // Oldest first, as they happened.
    expect(news!.text.indexOf("Three meetings")).toBeLessThan(news!.text.indexOf("No access"));
  });

  it("passes on nothing for another lane, or when nothing finished", async () => {
    await turn(5);
    expect(await laneNews(db, await conversation(), time)).toBeNull();
    const automation = await run({ lane: "inbox", status: "queued", completedAt: null });
    await run({ lane: `schedule:${scheduleId}`, completedAt: minutesAgo(1), finalText: "Done" });
    expect(await laneNews(db, automation, time)).toBeNull();
  });

  it("caps how much it passes on, and marks the turn when a result read your accounts", async () => {
    for (let index = 0; index < LANE_NEWS_LIMIT + 2; index++)
      await run({
        lane: "inbox",
        completedAt: minutesAgo(60 - index),
        finalText: `Email ${index}`,
        readOutsideData: index === LANE_NEWS_LIMIT + 1,
      });
    await run({
      lane: "inbox",
      completedAt: minutesAgo(1),
      finalText: "x".repeat(LANE_NEWS_LENGTH + 100),
    });
    const news = await laneNews(db, await conversation(), time);
    expect(news!.readOutsideData).toBe(true);
    expect(news!.text).toContain("More finished before these");
    expect(news!.text).not.toContain("Email 0");
    expect(news!.text).toContain(`Email ${LANE_NEWS_LIMIT + 1}`);
    expect(news!.text).toContain("cut short");
    expect(news!.text).not.toContain("x".repeat(LANE_NEWS_LENGTH + 1));
  });

  it("counts only turns Codex took as having heard it, and leaves later results for the next", async () => {
    await turn(40);
    await run({ lane: "inbox", completedAt: minutesAgo(30), finalText: "Invoice filed" });
    // This one failed while the computer woke, before Codex heard anything.
    await run({
      lane: "chat",
      status: "failed",
      startedAt: minutesAgo(20),
      completedAt: minutesAgo(19),
    });
    await run({ lane: "inbox", completedAt: minutesAgo(1), finalText: "Refund drafted" });
    const current = await conversation(minutesAgo(2));

    const news = await laneNews(db, current, time);
    expect(news!.text).toContain("Invoice filed");
    // It finished after this turn started: the next turn hears it, once.
    expect(news!.text).not.toContain("Refund drafted");
    await db
      .update(runs)
      .set({ codexTurnId: "turn-now", status: "completed", completedAt: new Date() })
      .where(eq(runs.id, current.id));
    const next = await laneNews(db, await conversation(), time);
    expect(next!.text).toContain("Refund drafted");
    expect(next!.text).not.toContain("Invoice filed");
  });
});
