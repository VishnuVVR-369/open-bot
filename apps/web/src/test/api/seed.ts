import type { testDatabase } from "@open-bot/db/testing";
type TestDatabase = ReturnType<typeof testDatabase>;
type ApiIds = Record<
  "teammate" | "chat" | "run" | "schedule" | "trigger" | "page" | "version" | "memory",
  string
>;
/** A row's teammate, under the column's legacy name. */
export const owned = <T extends string | null>(teammateId: T) => ({ botId: teammateId });
export async function seedApi(database: TestDatabase, ids: ApiIds) {
  const s = await import("@open-bot/db");
  const db = database.db;
  const now = new Date();
  await db.insert(s.settings).values({ id: 1, timezone: "Europe/Berlin" }).onConflictDoNothing();
  await db.insert(s.bots).values({
    id: ids.teammate,
    name: "Scout",
    slug: "scout",
    role: "Researcher",
    color: "#3b82f6",
  });
  await db
    .insert(s.chats)
    .values({ id: ids.chat, kind: "direct", title: "Scout", ...owned(ids.teammate) });
  await db.insert(s.chatMembers).values({ chatId: ids.chat, ...owned(ids.teammate) });
  await db.insert(s.runs).values({
    id: ids.run,
    chatId: ids.chat,
    ...owned(ids.teammate),
    trigger: "schedule",
    prompt: "Check the news",
    status: "completed",
    scheduleId: null,
    startedAt: now,
    completedAt: now,
  });
  await db.insert(s.runEvents).values({
    runId: ids.run,
    chatId: ids.chat,
    payload: { type: "status", status: "completed" },
  });
  await db.insert(s.schedules).values({
    id: ids.schedule,
    ...owned(ids.teammate),
    title: "Morning news",
    prompt: "Check the news",
    kind: "cron",
    cron: "0 8 * * *",
    timezone: "Europe/Berlin",
    createdBy: "user",
  });
  await db.update(s.runs).set({ scheduleId: ids.schedule });
  await db.insert(s.triggers).values({
    id: ids.trigger,
    ...owned(ids.teammate),
    kind: "watch",
    title: "Pricing page",
    prompt: "Tell me when it changes",
    url: "https://example.test/pricing",
    intervalMinutes: 60,
    createdBy: "user",
  });
  await db.insert(s.tasks).values({ title: "Book flights", createdBy: "user" });
  await db.insert(s.skills).values({
    name: "summarize",
    description: "Summarize a page",
    instructions: "Read it and summarize it.",
    createdBy: "user",
  });
  await db
    .insert(s.notifications)
    .values({ kind: "run_finished", title: "Done", ...owned(ids.teammate) });
  await db
    .insert(s.connections)
    .values({ label: "Docs", name: "docs", transport: "http", url: "https://mcp.test" });
  await db.insert(s.purchases).values({
    ...owned(ids.teammate),
    amountCents: 1200,
    merchant: "Books",
    description: "A book",
    status: "paid",
  });
  await db.insert(s.pages).values({ id: ids.page, title: "Trip plan", ...owned(ids.teammate) });
  await db.insert(s.pageVersions).values({
    id: ids.version,
    pageId: ids.page,
    number: 1,
    title: "Trip plan",
    html: "<h1>Trip plan</h1>",
    size: 18,
    sha256: "0".repeat(64),
  });
  await db.update(s.pages).set({ currentVersionId: ids.version, versionCount: 1 });
  // A memory a teammate saved during the run, so its list names the teammate and the chat.
  const { memory } = await import("@/features/memory/server");
  const saved = await memory.save(
    {
      ...owned(ids.teammate),
      kind: "preference",
      content: "Prefers window seats",
      key: null,
      pinned: false,
      expiresAt: null,
    },
    { kind: "bot", botId: ids.teammate, runId: ids.run, verified: true },
  );
  ids.memory = saved.id;
  // A lesson is a memory; the lessons table is its projection.
  await memory.addLessons(ids.teammate, ["Keep it short."]);
}
