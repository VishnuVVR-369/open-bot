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
import { LANE_NEWS_LENGTH, LANE_NEWS_LIMIT, laneNews, markPassedOn } from "./lane-news";

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
    completedAt?: Date | null;
    status?: "queued" | "running" | "completed" | "failed";
    finalText?: string | null;
    error?: string | null;
    quiet?: boolean;
    readOutsideData?: boolean;
    scheduleId?: string | null;
    passedOnAt?: Date | null;
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

  /** The conversation's run that is about to take its turn. */
  const conversation = () => run({ lane: "chat", status: "queued", completedAt: null });

  it("passes on what other lanes finished that the conversation hasn't heard", async () => {
    await run({
      lane: "inbox",
      completedAt: minutesAgo(50),
      finalText: "Old email, heard already",
      passedOnAt: minutesAgo(40),
    });
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
    await run({ lane: "inbox", status: "running", completedAt: null });

    const news = await laneNews(db, await conversation(), time);
    expect(news!.readOutsideData).toBe(false);
    expect(news!.runIds).toHaveLength(2);
    expect(news!.text).toContain('Your routine "Morning briefing", at ');
    expect(news!.text).toContain("  Three meetings today.");
    expect(news!.text).toContain("An email you received");
    expect(news!.text).toContain("It failed: No access");
    expect(news!.text).not.toContain("Old email");
    // Oldest first, as they happened.
    expect(news!.text.indexOf("Three meetings")).toBeLessThan(news!.text.indexOf("No access"));
  });

  it("passes on nothing for another lane, or when nothing finished", async () => {
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
    // Those only counted are heard too, so they don't come back next turn.
    expect(news!.runIds).toHaveLength(LANE_NEWS_LIMIT + 3);
    await markPassedOn(db, news!.runIds);
    expect(await laneNews(db, await conversation(), time)).toBeNull();
  });

  it("passes a result on once its turn began, however late its completion was saved", async () => {
    const briefing = await run({
      lane: `schedule:${scheduleId}`,
      scheduleId,
      status: "running",
      completedAt: null,
    });
    // A turn whose prompt was built but that never reached Codex didn't hear it.
    const first = await laneNews(db, await conversation(), time);
    expect(first).toBeNull();
    // The briefing's completion is saved after the conversation's turn began, with the time it
    // finished, which is earlier.
    await db
      .update(runs)
      .set({ status: "completed", completedAt: minutesAgo(5), finalText: "Three meetings today." })
      .where(eq(runs.id, briefing.id));
    const next = await laneNews(db, await conversation(), time);
    expect(next!.text).toContain("Three meetings today.");
    // Building a prompt doesn't count as hearing it; a turn that began does.
    expect((await laneNews(db, await conversation(), time))!.runIds).toEqual([briefing.id]);
    await markPassedOn(db, next!.runIds);
    expect(await laneNews(db, await conversation(), time)).toBeNull();
  });
});
