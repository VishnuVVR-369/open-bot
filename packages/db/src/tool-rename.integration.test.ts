// Migration 0042 renames the tool calls that open approvals cover (create_bot to create_teammate,
// bot_id to teammate_id, ...) and hashes them again. The database is migrated up to 0041, old-shaped
// approvals are saved, and then the real migrator applies the rest, as a deploy does.
// The rows are saved with raw SQL in the 0041 shape: the schema in code has the names of 0043.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configurationRevision } from "./configuration";
import { approvals } from "./schema";
import { testDatabase, testDatabaseServer } from "./testing";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const RENAME_TAG = "0042_rename_teammate_tools_in_approvals";

const server = testDatabaseServer();
const database = testDatabase(server);
const { db, pool } = database;

type Operation = { tool: string; arguments: Record<string, unknown> };

const TEAMMATE_ID = "00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000002";
const CHAT_ID = "00000000-0000-4000-8000-000000000003";
const RUN_ID = "00000000-0000-4000-8000-000000000004";
/** Text that JSON escapes, so the database's hash has to escape it as JSON.stringify does. */
const AWKWARD = 'Line one\nLine "two"\ttabbed \\ back\u0001slash, café 🚀 /';

describe.skipIf(!server)("migration 0042: approvals for renamed tools", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await database.create({ through: "0041_drop_usage_entries" });
    await pool.query(
      `insert into bots (id, name, slug, role, color) values ($1, 'Ada', 'ada', 'researcher', '#4f46e5')`,
      [TEAMMATE_ID],
    );
    await pool.query(
      `insert into chats (id, kind, title, bot_id) values ($1, 'direct', 'Ada', $2)`,
      [CHAT_ID, TEAMMATE_ID],
    );
    await pool.query(
      `insert into runs (id, chat_id, bot_id, trigger, prompt) values ($1, $2, $3, 'user', 'Set up')`,
      [RUN_ID, CHAT_ID, TEAMMATE_ID],
    );
    const save = async (
      name: string,
      status: "pending" | "approved" | "denied",
      payload: Record<string, unknown>,
      kind: "action" | "command" = "action",
    ) => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into approvals (run_id, bot_id, chat_id, kind, title, status, payload, item_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [RUN_ID, TEAMMATE_ID, CHAT_ID, kind, name, status, payload, `${name}-approval`],
      );
      ids[name] = rows[0]!.id;
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
          tool: "update_bot",
          arguments: {
            bot_id: TEAMMATE_ID,
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
        tool: "create_bot",
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
          tool: "set_bot_connection",
          arguments: {
            bot_id: TEAMMATE_ID,
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
          bot_id: TEAMMATE_ID,
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
          tool: "update_bot",
          arguments: { bot_id: TEAMMATE_ID, expected_revision: "r0", changes: { name: "Old" } },
        },
        { consumed: true },
      ),
    );
    await save(
      "denied",
      "denied",
      asked({
        tool: "create_bot",
        arguments: { name: "No", role: "researcher" },
      }),
    );
    // A connection's tool takes that service's own arguments, which aren't ours to rename.
    const mcpCall = (status: "pending" | "approved", chat: string) =>
      save(
        `mcp-${status}`,
        status,
        asked({
          tool: "mcp:telegram.get_chat",
          arguments: { bot_id: "external-bot-123", chat_id: chat }, // vocabulary: allow
        }),
      );
    await mcpCall("pending", "1");
    await mcpCall("approved", "2");
    await save("command", "pending", { subject: "ls -la" }, "command");
    await save(
      "unrelated",
      "pending",
      asked({ tool: "schedule_task", arguments: { title: "Mine", prompt: "Check" } }),
    );

    // The deploy: the real migrator applies what is left.
    await database.migrate();
  });

  afterAll(() => database.drop());

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
    expect(consumed.operation?.tool).toBe("update_bot");
    expect(consumed.consumed).toBe(true);
    expect((await payload("denied")).operation?.tool).toBe("create_bot");
    expect(await payload("command")).toEqual({ subject: "ls -la" });
    const unrelated = { tool: "schedule_task", arguments: { title: "Mine", prompt: "Check" } };
    expect(await payload("unrelated")).toEqual({
      operation: unrelated,
      operationKey: configurationRevision(unrelated),
    });
  });

  it("leaves a connection's tool calls as they were, arguments and all", async () => {
    for (const [status, chat] of [
      ["pending", "1"],
      ["approved", "2"],
    ] as const) {
      const call = {
        tool: "mcp:telegram.get_chat",
        arguments: { bot_id: "external-bot-123", chat_id: chat }, // vocabulary: allow
      };
      expect(await payload(`mcp-${status}`)).toEqual({
        operation: call,
        operationKey: configurationRevision(call),
      });
    }
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
