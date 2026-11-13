import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { approvals, bots as teammates, chats, runs } from "@open-bot/db"; // vocabulary: allow (the schema's name until the rename)
import type { ApprovalStatus } from "@open-bot/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = testDatabaseServer();

describe.skipIf(!url)("the approvals list", () => {
  const database = testDatabase(url);
  let listApprovals: typeof import("./service").listApprovals;

  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    ({ listApprovals } = await import("./service"));
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/server/db");
    await pool.end();
    await database.drop();
  });

  it("puts waiting approvals first, then the rest, each newest first, 100 at most", async () => {
    const owned = (teammateId: string) => ({ botId: teammateId }); // vocabulary: allow (the schema's column until the rename)
    const [teammate] = await database.db
      .insert(teammates)
      .values({ name: "Scout", slug: "scout", role: "Researcher", color: "#3b82f6" })
      .returning();
    if (!teammate) throw new Error("No teammate.");
    const [chat] = await database.db
      .insert(chats)
      .values({ kind: "direct", title: "Scout", ...owned(teammate.id) })
      .returning();
    if (!chat) throw new Error("No chat.");
    const [run] = await database.db
      .insert(runs)
      .values({ chatId: chat.id, ...owned(teammate.id), trigger: "user", prompt: "Go" })
      .returning();
    if (!run) throw new Error("No run.");
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
    const approval = (title: string, status: ApprovalStatus, minute: number) => ({
      runId: run.id,
      chatId: chat.id,
      ...owned(teammate.id),
      kind: "command" as const,
      title,
      status,
      itemId: `item ${title}`,
      createdAt: at(minute),
    });
    await database.db
      .insert(approvals)
      .values([
        approval("old denied", "denied", 1),
        approval("old waiting", "pending", 2),
        approval("new approved", "approved", 3),
        approval("new waiting", "pending", 4),
        ...Array.from({ length: 100 }, (_, n) => approval(`expired ${n}`, "expired", 0)),
      ]);

    const list = await listApprovals();

    expect(list).toHaveLength(100);
    expect(list.slice(0, 4).map((item) => item.title)).toEqual([
      "new waiting",
      "old waiting",
      "new approved",
      "old denied",
    ]);
    expect(list[0]).toMatchObject({ status: "pending", createdAt: at(4).toISOString() });
  });
});
