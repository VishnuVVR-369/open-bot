import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  bots, // vocabulary: allow
  modelLogGaps,
  modelRequestItems,
  modelRequests,
} from "@open-bot/db";
import { modelBlob } from "@open-bot/domain/server";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequestRecord } from "./capture";
import { ModelLogWriter } from "./writer";

const url = testDatabaseServer();

/** A request as the proxy records it, with one input item. */
function record(
  endpoint: string,
  row: Partial<ModelRequestRecord["row"]> = {},
): ModelRequestRecord {
  const item = modelBlob("item", { type: "message", role: "user", content: endpoint });
  return {
    row: {
      id: randomUUID(),
      source: "codex",
      route: "api",
      transport: "http",
      method: "POST",
      endpoint,
      startedAt: new Date(),
      requestHeaders: {},
      ...row,
    },
    blobs: [item],
    items: [{ side: "input", position: 0, blobHash: item.hash }],
    toolCalls: [],
    bytes: 1_000,
  };
}

describe.skipIf(!url)("model log writer", () => {
  const database = testDatabase(url);
  const { db } = database;
  let writer: ModelLogWriter;

  beforeAll(() => database.create());
  afterAll(() => database.drop());

  beforeEach(async () => {
    await writer?.stop();
    // A batch is written as soon as three requests wait, so each test sends one batch.
    writer = new ModelLogWriter(
      db,
      { warn() {}, error() {} },
      { flushMs: 60_000, batchRows: 3, retryForMs: 60_000, backoffMs: 5, maxBackoffMs: 20 },
    );
  });

  it("drops only the request the database refuses, and saves the rest of its batch", async () => {
    const dropped = once(writer, "dropped");
    const gap = once(writer, "gap");
    writer.add(record("/first"));
    // A value the table's check refuses: sending it again can never succeed.
    writer.add(record("/refused", { source: "bogus" as "codex" }));
    writer.add(record("/third"));

    const [lost, reason] = (await dropped) as [number, string];
    expect(lost).toBe(1);
    expect(reason).toContain("the database refused it");
    await gap;

    const rows = await db
      .select({ endpoint: modelRequests.endpoint })
      .from(modelRequests)
      .orderBy(asc(modelRequests.endpoint));
    expect(rows.map((row) => row.endpoint)).toEqual(["/first", "/third"]);
    expect(await db.select().from(modelRequestItems)).toHaveLength(2);
    const [saved] = await db.select().from(modelLogGaps);
    expect(saved).toMatchObject({ requests: 1 });
    expect(writer.pending).toBe(0);
  });

  it("counts requests lost while a gap is being written in the next gap only", async () => {
    // Every request is past the queue's cap, so each one is lost at once.
    writer = new ModelLogWriter(
      db,
      { warn() {}, error() {} },
      { flushMs: 5, maxQueueBytes: 500, backoffMs: 5, maxBackoffMs: 20 },
    );
    // Hold the gap table, so the first gap's write waits.
    const holder = await database.pool.connect();
    await holder.query("begin");
    await holder.query("lock table model_log_gaps in access exclusive mode");
    let saved = 0;
    const allSaved = new Promise<void>((resolve) =>
      writer.on("gap", (requests) => {
        saved += requests;
        if (saved >= 2) resolve();
      }),
    );
    writer.add(record("/lost-first"));
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_locks
               where not granted and relation = 'model_log_gaps'::regclass`,
            )
          ).rows[0]!.waiting,
      )
      .toBe(1);
    writer.add(record("/lost-second"));
    await holder.query("commit");
    holder.release();
    await allSaved;

    const gaps = await db
      .select({ requests: modelLogGaps.requests })
      .from(modelLogGaps)
      .where(eq(modelLogGaps.reason, "the log queue was full"));
    expect(gaps.map((gap) => gap.requests)).toEqual([1, 1]);
  });

  it("keeps the request of a teammate deleted since, without naming it", async () => {
    const [teammate] = await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Gone", slug: `gone-${randomUUID()}`, role: "assistant", color: "violet" })
      .returning();
    await db.delete(bots).where(eq(bots.id, teammate!.id)); // vocabulary: allow
    const [present] = await db
      .insert(bots) // vocabulary: allow
      .values({ name: "Here", slug: `here-${randomUUID()}`, role: "assistant", color: "violet" })
      .returning();

    const saved = once(writer, "written");
    writer.add(record("/deleted-teammate", { teammateId: teammate!.id }));
    writer.add(record("/live-teammate", { teammateId: present!.id }));
    writer.add(record("/no-teammate"));
    await saved;

    const rows = await db
      .select({ endpoint: modelRequests.endpoint, teammateId: modelRequests.teammateId })
      .from(modelRequests)
      .where(eq(modelRequests.source, "codex"))
      .orderBy(asc(modelRequests.endpoint));
    expect(rows.filter((row) => row.endpoint.includes("teammate"))).toEqual([
      { endpoint: "/deleted-teammate", teammateId: null },
      { endpoint: "/live-teammate", teammateId: present!.id },
      { endpoint: "/no-teammate", teammateId: null },
    ]);
  });
});
