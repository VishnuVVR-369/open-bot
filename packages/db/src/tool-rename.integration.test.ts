// Migration 0034 renames the tool calls that open approvals cover (create_bot to create_teammate,
// bot_id to teammate_id, ...) and hashes them again. The database is migrated up to 0033, old-shaped
// approvals are saved, and then the real migrator applies the rest, as a deploy does.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configurationRevision } from "./configuration";
import { approvals, chats, runs, teammates } from "./schema";
import { testDatabase, testDatabaseServer } from "./testing";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const RENAME_TAG = "0034_rename_teammate_tools_in_approvals";

const server = testDatabaseServer();
const database = testDatabase(server);
const { db, pool } = database;

/** The migrations folder as it was before the rename: every migration up to 0033. */
async function migrationsBefore(tag: string): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "openbot-migrations-"));
  await mkdir(path.join(folder, "meta"));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const file of await readdir(MIGRATIONS))
    if (file.endsWith(".sql")) await copyFile(path.join(MIGRATIONS, file), path.join(folder, file));
  return folder;
}

type Operation = { tool: string; arguments: Record<string, unknown> };

const TEAMMATE_ID = "00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000002";
/** Text that JSON escapes, so the database's hash has to escape it as JSON.stringify does. */
const AWKWARD = 'Line one\nLine "two"\ttabbed \\ back\u0001slash, café 🚀 /';

describe.skipIf(!server)("migration 0034: approvals for renamed tools", () => {
  let folder = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query(`create database ${new URL(database.url).pathname.slice(1)}`);
    await admin.end();
    folder = await migrationsBefore(RENAME_TAG);
    await migrate(db, { migrationsFolder: folder });

    const [teammate] = await db
      .insert(teammates)
      .values({ id: TEAMMATE_ID, name: "Ada", slug: "ada", role: "researcher", color: "#4f46e5" })
      .returning();
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: "Ada", teammateId: teammate!.id })
      .returning();
    const [run] = await db
      .insert(runs)
      .values({ chatId: chat!.id, teammateId: teammate!.id, trigger: "user", prompt: "Set up" })
      .returning();
    const save = async (
      name: string,
      status: "pending" | "approved" | "denied",
      payload: Record<string, unknown>,
      kind: "action" | "command" = "action",
    ) => {
      const [row] = await db
        .insert(approvals)
        .values({
          runId: run!.id,
          teammateId: teammate!.id,
          chatId: chat!.id,
          kind,
          title: name,
          status,
          payload,
          itemId: `${name}-approval`,
        })
        .returning({ id: approvals.id });
      ids[name] = row!.id;
    };
    const asked = (operation: Operation, extra: Record<string, unknown> = {}) => ({
      operation,
      operationKey: configurationRevision(operation),
      ...extra,
    });

    await save(
      "update",
      "pending",
      asked(
        {
          tool: "update_bot", // vocabulary: allow
          arguments: {
            bot_id: TEAMMATE_ID, // vocabulary: allow
            expected_revision: "r1",
            changes: { name: "Iris", instructions: AWKWARD, emoji: null },
          },
        },
        { subject: "Edit teammates' profiles" },
      ),
    );
    await save(
      "create",
      "approved",
      asked({
        tool: "create_bot", // vocabulary: allow
        arguments: {
          name: "Rex",
          role: "researcher",
          autonomy: "risky",
          skills: [{ name: "brief", description: "Brief", instructions: AWKWARD }],
          schedules: [{ title: "Daily", prompt: "Check", cron: "0 9 * * *" }],
          starter_ids: [],
        },
      }),
    );
    await save(
      "connection",
      "pending",
      asked(
        {
          tool: "set_bot_connection", // vocabulary: allow
          arguments: {
            bot_id: TEAMMATE_ID, // vocabulary: allow
            connection_id: CONNECTION_ID,
            assigned: true,
            expected_revision: "c1",
          },
        },
        { askEveryTime: true },
      ),
    );
    await save(
      "setup",
      "approved",
      asked({
        tool: "watch_calendar",
        arguments: {
          bot_id: TEAMMATE_ID, // vocabulary: allow
          title: "Before meetings",
          prompt: AWKWARD,
          lead_minutes: 30,
          events: "guests",
        },
      }),
    );
    // Used up or turned down: history, left as it was.
    await save(
      "consumed",
      "approved",
      asked(
        {
          tool: "update_bot", // vocabulary: allow
          arguments: { bot_id: TEAMMATE_ID, expected_revision: "r0", changes: { name: "Old" } }, // vocabulary: allow
        },
        { consumed: true },
      ),
    );
    await save(
      "denied",
      "denied",
      asked({
        tool: "create_bot", // vocabulary: allow
        arguments: { name: "No", role: "researcher" },
      }),
    );
    await save("command", "pending", { subject: "ls -la" }, "command");
    await save(
      "unrelated",
      "pending",
      asked({ tool: "schedule_task", arguments: { title: "Mine", prompt: "Check" } }),
    );

    // The deploy: the real migrator applies what is left.
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  afterAll(async () => {
    await database.drop();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  async function payload(name: string) {
    const [row] = await db
      .select({ payload: approvals.payload })
      .from(approvals)
      .where(eq(approvals.id, ids[name]!));
    return row!.payload as { operation?: Operation; operationKey?: string } & Record<
      string,
      unknown
    >;
  }

  /** The call the follow-up run makes with the renamed tool must match the saved approval. */
  async function expectRenamed(name: string, operation: Operation) {
    const saved = await payload(name);
    expect(saved.operation).toEqual(operation);
    expect(saved.operationKey).toBe(configurationRevision(operation));
    return saved;
  }

  it("renames an open update and hashes it as the worker will", async () => {
    const saved = await expectRenamed("update", {
      tool: "update_teammate",
      arguments: {
        teammate_id: TEAMMATE_ID,
        expected_revision: "r1",
        changes: { name: "Iris", instructions: AWKWARD, emoji: null },
      },
    });
    expect(saved.subject).toBe("Edit teammates' profiles");
  });

  it("renames an approved creation that wasn't used yet, nested values and all", async () => {
    await expectRenamed("create", {
      tool: "create_teammate",
      arguments: {
        name: "Rex",
        role: "researcher",
        autonomy: "risky",
        skills: [{ name: "brief", description: "Brief", instructions: AWKWARD }],
        schedules: [{ title: "Daily", prompt: "Check", cron: "0 9 * * *" }],
        starter_ids: [],
      },
    });
  });

  it("renames a connection change and keeps its other fields", async () => {
    const saved = await expectRenamed("connection", {
      tool: "set_teammate_connection",
      arguments: {
        teammate_id: TEAMMATE_ID,
        connection_id: CONNECTION_ID,
        assigned: true,
        expected_revision: "c1",
      },
    });
    expect(saved.askEveryTime).toBe(true);
  });

  it("renames the target of another teammate's setup, under the same tool", async () => {
    await expectRenamed("setup", {
      tool: "watch_calendar",
      arguments: {
        teammate_id: TEAMMATE_ID,
        title: "Before meetings",
        prompt: AWKWARD,
        lead_minutes: 30,
        events: "guests",
      },
    });
  });

  it("leaves used, denied and unrelated approvals as they were", async () => {
    const consumed = await payload("consumed");
    expect(consumed.operation?.tool).toBe("update_bot"); // vocabulary: allow
    expect(consumed.consumed).toBe(true);
    expect((await payload("denied")).operation?.tool).toBe("create_bot"); // vocabulary: allow
    expect(await payload("command")).toEqual({ subject: "ls -la" });
    const unrelated = { tool: "schedule_task", arguments: { title: "Mine", prompt: "Check" } };
    expect(await payload("unrelated")).toEqual({
      operation: unrelated,
      operationKey: configurationRevision(unrelated),
    });
  });

  it("changes nothing when it runs again", async () => {
    const before = await db.select().from(approvals);
    const sql = await readFile(path.join(MIGRATIONS, `${RENAME_TAG}.sql`), "utf8");
    const client = await pool.connect();
    try {
      for (const statement of sql.split("--> statement-breakpoint")) await client.query(statement);
    } finally {
      client.release();
    }
    expect(await db.select().from(approvals)).toEqual(before);
  });
});
