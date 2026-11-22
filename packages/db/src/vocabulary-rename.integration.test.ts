// Migration 0043 renames the database to the glossary's words: tables, columns, constraints and
// indexes, the values stored under the old words, and the one function body that read an old
// column. The database is migrated up to 0042 and
// filled through raw SQL with the old names, then the real migrator applies the rest, as a deploy
// does. Every row of every table must come out as the same row with only the renames applied, and
// running the migration again must change nothing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "./testing";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const RENAME_TAG = "0043_rename_vocabulary";
const BEFORE_TAG = "0042_rename_teammate_tools_in_approvals";

const server = testDatabaseServer();
const database = testDatabase(server);
const { pool } = database;

type Row = Record<string, unknown>;
type Dump = Record<string, Row[]>;

/** JSON with sorted keys, so two equal rows always print the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Every row of every table, each table's rows in a stable order. */
async function dump(): Promise<Dump> {
  const { rows: tables } = await pool.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  const out: Dump = {};
  for (const { name } of tables) {
    const { rows } = await pool.query<{ row: Row }>(
      `select row_to_json(t) as row from public.${JSON.stringify(name)} t`,
    );
    out[name] = rows.map((r) => r.row).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  return out;
}

const TABLES: Record<string, string> = {
  bots: "teammates",
  bot_threads: "teammate_threads",
  desktop_takeovers: "screen_takeovers",
  accounts: "account_connections",
};
const COLUMNS: Record<string, string> = {
  bot_id: "teammate_id",
  bot_ids: "teammate_ids",
  owner_bot_id: "owner_teammate_id",
  created_by_bot_id: "created_by_teammate_id",
  requested_by_bot_id: "requested_by_teammate_id",
  is_primary: "is_lead",
};
const renameKey = (value: Row, from: string, to: string): Row => {
  if (!(from in value)) return value;
  const { [from]: kept, ...rest } = value;
  return { ...rest, [to]: kept };
};
const memorySource = (source: Row): Row =>
  renameKey(
    source.type === "bot" ? { ...source, type: "teammate" } : source,
    "botId",
    "teammateId",
  );

/** What the migration must make of one row: the renames, and nothing else. */
function expected(table: string, row: Row): Row {
  let out: Row = {};
  for (const [column, value] of Object.entries(row)) out[COLUMNS[column] ?? column] = value;
  if (["skills", "tasks", "schedules", "triggers"].includes(table) && out.created_by === "bot")
    out.created_by = "teammate";
  if (table === "notifications" && out.kind === "bot_message") out.kind = "teammate_message";
  if (table === "memory_items" || table === "memory_revisions")
    out.source = memorySource(out.source as Row);
  if (table === "memory_generations")
    out.scope = (out.scope as string).replace(/^bot:/, "teammate:");
  if (table === "memory_imports")
    out.key = (out.key as string).replace(/^forgotten:bot:/, "forgotten:teammate:");
  if (table === "oauth_states")
    out.purpose = renameKey(out.purpose as Row, "botIds", "teammateIds");
  if (table === "run_events") {
    const payload = out.payload as Row;
    const item = payload.item as Row | undefined;
    if (payload.type === "item" && item?.kind === "handoff")
      out = {
        ...out,
        payload: {
          ...payload,
          item: renameKey(
            renameKey(item, "toBotId", "toTeammateId"),
            "toBotName",
            "toTeammateName",
          ),
        },
      };
  }
  return out;
}

const ADA = "00000000-0000-4000-8000-00000000000a";
const REX = "00000000-0000-4000-8000-00000000000b";
const GROUP = "00000000-0000-4000-8000-0000000000c1";
const RUN = "00000000-0000-4000-8000-0000000000d1";
const TAKEOVER = "00000000-0000-4000-8000-0000000000e1";
const CLIENT = "00000000-0000-4000-8000-0000000000f1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000f2";
const CONNECTION = "00000000-0000-4000-8000-0000000000f3";
const MEMORY = "00000000-0000-4000-8000-0000000000a1";
/** A run with usage from before the model logs (migration 0040), which a deletion keeps. */
const LEGACY_RUN = "00000000-0000-4000-8000-0000000000d2";

/** Every value stored under an old word, and neighbours that look alike but must not change. */
const SEED = [
  `insert into bots (id, name, slug, role, color, is_primary) values
     ('${ADA}', 'Ada', 'ada', 'researcher', '#4f46e5', true),
     ('${REX}', 'Rex', 'rex', 'writer', '#16a34a', false)`,
  `insert into chats (id, kind, title, bot_id) values ('${GROUP}', 'group', 'Team', null)`,
  `insert into chat_members (chat_id, bot_id) values ('${GROUP}', '${ADA}'), ('${GROUP}', '${REX}')`,
  `insert into bot_threads (chat_id, bot_id, codex_thread_id) values ('${GROUP}', '${ADA}', 'thread-ada')`,
  `insert into runs (id, chat_id, bot_id, trigger, prompt) values ('${RUN}', '${GROUP}', '${ADA}', 'user', 'Ask Rex')`,
  `insert into runs (id, chat_id, bot_id, trigger, prompt, status, legacy_plan_input_tokens,
       legacy_plan_cached_input_tokens, legacy_plan_output_tokens, legacy_plan_cost_micros, legacy_usage_at)
     values ('${LEGACY_RUN}', '${GROUP}', '${REX}', 'user', 'Earlier', 'completed', 1200, 300, 80, 0,
       '2026-11-02T10:00:00Z')`,
  // An automation lane's thread, and a logged model request, both naming their teammate.
  `insert into chat_lane_threads (chat_id, teammate_id, lane, codex_thread_id) values
     ('${GROUP}', '${ADA}', 'schedule:daily', 'thread-ada-daily')`,
  `insert into model_requests (id, source, route, transport, method, endpoint, codex_thread_id,
       codex_turn_id, teammate_id, model, status, started_at, request_headers) values
     ('00000000-0000-4000-8000-0000000000b1', 'codex', 'plan', 'websocket', 'response.create',
       '/responses', 'thread-ada', 'turn-1', '${ADA}', 'gpt-6.1-sol', 200, '2026-11-02T10:00:00Z',
       '{"x-codex-turn-metadata":"{}"}')`,
  `insert into run_turns (codex_thread_id, codex_turn_id, run_id, access_mode, started_at) values
     ('thread-ada', 'turn-1', '${RUN}', 'plan', '2026-11-02T10:00:00Z')`,
  // A handoff, another item that only quotes the old keys in its text, and an older handoff saved
  // with only one of them.
  `insert into run_events (run_id, chat_id, payload) values
     ('${RUN}', '${GROUP}', '{"type":"item","item":{"id":"h1","kind":"handoff","toBotId":"${REX}","toBotName":"Rex","message":"Over to you"}}'),
     ('${RUN}', '${GROUP}', '{"type":"item","item":{"id":"m1","kind":"message","text":"toBotId stays in text"}}'),
     ('${RUN}', '${GROUP}', '{"type":"item","item":{"id":"h2","kind":"handoff","toBotName":"Rex","message":"Partial"}}'),
     ('${RUN}', '${GROUP}', '{"type":"delta","itemId":"m1","delta":"no bot_message here"}')`,
  `insert into memory_items (id, bot_id, content, fingerprint, source) values
     ('${MEMORY}', '${ADA}', 'Prefers remote jobs', 'fp-1', '{"type":"bot","runId":"${RUN}","messageId":"m1"}'),
     ('00000000-0000-4000-8000-0000000000a2', null, 'Shared fact', 'fp-2', '{"type":"user"}'),
     ('00000000-0000-4000-8000-0000000000a3', '${REX}', 'Listed once', 'fp-3', '{"type":"bot","botId":"${REX}","chatId":"${GROUP}"}')`,
  `insert into memory_revisions (memory_id, revision, content, snapshot, source) values
     ('${MEMORY}', 1, 'Prefers remote jobs', '{"kind":"fact","key":null,"pinned":false,"expiresAt":null,"state":"active"}', '{"type":"bot","runId":"${RUN}"}'),
     ('${MEMORY}', 2, 'Prefers remote work', '{"kind":"fact","key":null,"pinned":false,"expiresAt":null,"state":"active"}', '{"type":"feedback"}')`,
  `insert into memory_generations (scope, generation) values ('bot:${ADA}', 4), ('bot:${REX}', 1), ('shared', 7)`,
  `insert into memory_imports (key) values
     ('forgotten:bot:${ADA}:abc123'), ('forgotten:shared:def456'), ('forget-source:m9'), ('legacy:bot:x')`,
  `insert into skills (name, description, instructions, created_by, bot_id, created_by_bot_id) values
     ('brief', 'Brief', 'Write it', 'bot', '${ADA}', '${ADA}'),
     ('mine', 'Mine', 'Do it', 'user', null, null)`,
  `insert into tasks (title, created_by, owner_bot_id, created_by_bot_id) values
     ('Ship it', 'bot', '${REX}', '${ADA}'), ('Yours', 'user', null, null)`,
  `insert into schedules (bot_id, title, prompt, kind, timezone, created_by) values
     ('${ADA}', 'Daily', 'Check', 'cron', 'UTC', 'bot'), ('${REX}', 'Weekly', 'Report', 'cron', 'UTC', 'user')`,
  `insert into triggers (bot_id, kind, title, prompt, created_by) values
     ('${ADA}', 'webhook', 'Hook', 'Handle it', 'bot'), ('${REX}', 'webhook', 'Other', 'Handle it', 'user')`,
  `insert into notifications (kind, title, bot_id, chat_id, run_id) values
     ('bot_message', 'Ada says hi', '${ADA}', '${GROUP}', '${RUN}'),
     ('run_finished', 'Ada replied', '${ADA}', '${GROUP}', '${RUN}')`,
  `insert into desktop_takeovers (id, screen_id, status, requested_by_bot_id, requested_by_run_id) values
     ('${TAKEOVER}', '${ADA}', 'active', '${ADA}', '${RUN}')`,
  `insert into screen_operations (id, screen_id, takeover_id, status) values
     ('00000000-0000-4000-8000-0000000000e2', '${ADA}', '${TAKEOVER}', 'safe')`,
  `insert into takeover_deliveries (id) values ('${TAKEOVER}')`,
  `insert into oauth_clients (id, provider, source, client_id) values ('${CLIENT}', 'google', 'owner', 'client-1')`,
  `insert into accounts (id, provider, external_id, oauth_client_id, display, encrypted) values
     ('${ACCOUNT}', 'google', 'sub-1', '${CLIENT}', 'ada@example.com', 'sealed')`,
  `insert into connections (id, label, name, kind, account_id, bot_ids) values
     ('${CONNECTION}', 'Gmail', 'gmail', 'gmail', '${ACCOUNT}', array['${ADA}']::uuid[])`,
  `insert into account_actions (account_id, connection_id, bot_id, run_id, grant_revision, connection_revision, item_id, tool, effect, request, summary, labels, expires_at) values
     ('${ACCOUNT}', '${CONNECTION}', '${ADA}', '${RUN}', 1, 1, 'i1', 'gmail_send', 'others', '{"to":"x"}', 'Send', '{"waiting":"w","done":"d","failed":"f"}', now() + interval '1 day')`,
  `insert into oauth_states (state, provider, verifier, session_id, purpose, expires_at) values
     ('s1', 'google', 'v', 'sess', '{"kind":"gmail","capabilities":["read"],"botIds":["${ADA}"],"oauthClientId":"${CLIENT}"}', now() + interval '10 minutes'),
     ('s2', 'google', 'v', 'sess', '{"kind":"calendar","capabilities":["read"],"botIds":null,"oauthClientId":"${CLIENT}"}', now() + interval '10 minutes')`,
  `insert into vault_items (kind, name, hint, encrypted, bot_ids) values ('login', 'Site', 'a***', 'sealed', array['${REX}']::uuid[])`,
  `insert into approvals (run_id, bot_id, chat_id, kind, title, item_id, payload) values
     ('${RUN}', '${ADA}', '${GROUP}', 'command', 'ls', 'a1', '{"subject":"ls"}')`,
  `insert into approval_rules (bot_id, kind, pattern) values ('${ADA}', 'command', 'ls *')`,
  `insert into lessons (bot_id, text) values ('${ADA}', 'Be brief')`,
  `insert into memory_contexts (run_id, bot_id, generation) values ('${RUN}', '${ADA}', '7:4:0')`,
];

describe.skipIf(!server)("migration 0043: the database in the glossary's words", () => {
  let before: Dump = {};
  let after: Dump = {};

  beforeAll(async () => {
    await database.create({ through: BEFORE_TAG });
    for (const statement of SEED) await pool.query(statement);
    before = await dump();

    // The deploy: the real migrator applies this migration. Only through it, so a later
    // migration's new table isn't counted as one this migration made.
    await database.migrate({ through: RENAME_TAG });
    after = await dump();
  });

  afterAll(() => database.drop());

  it("seeded every table it renames, and every value it rewrites", () => {
    for (const table of Object.keys(TABLES))
      expect(before[table]?.length, table).toBeGreaterThan(0);
    const text = JSON.stringify(before);
    for (const old of ['"bot_message"', '"botIds"', '"toBotId"', '"toBotName"', '"botId"', "bot:"])
      expect(text, old).toContain(old);
  });

  it("keeps every row, with only the renames applied", () => {
    const wanted: Dump = {};
    for (const [table, rows] of Object.entries(before))
      wanted[TABLES[table] ?? table] = rows
        .map((row) => expected(table, row))
        .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    expect(Object.keys(after).sort()).toEqual(Object.keys(wanted).sort());
    for (const table of Object.keys(wanted))
      expect(after[table]!.map(canonical), table).toEqual(wanted[table]!.map(canonical));
  });

  it("leaves no table, column, constraint or index with an old name", async () => {
    const { rows } = await pool.query<{ name: string }>(`
      select relname as name from pg_class where relnamespace = 'public'::regnamespace
      union all select table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public'
      union all select conname from pg_constraint where connamespace = 'public'::regnamespace`);
    const old = rows
      .map((r) => r.name)
      .filter((name) => /(^|[._])(bots?|is_primary|desktop|accounts)([._]|$)/.test(name))
      .filter((name) => name !== "telegram.bot_username"); // Telegram's bot, not a teammate.
    expect(old).toEqual([]);
  });

  it("leaves the stored values in the new words", () => {
    const text = JSON.stringify(after);
    for (const old of ['"bot_message"', '"botIds"', '"toBotId"', '"toBotName"', '"botId"', '"bot:'])
      expect(text, old).not.toContain(old);
    // Look-alikes that aren't the old words stay: message text, a delta's text, other keys.
    expect(text).toContain("toBotId stays in text");
    expect(text).toContain("legacy:bot:x");
    expect(text).toContain("no bot_message here");
  });

  it("changes nothing when it runs again", async () => {
    const sql = await readFile(path.join(MIGRATIONS, `${RENAME_TAG}.sql`), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const statement of sql.split("--> statement-breakpoint")) await client.query(statement);
      await client.query("commit");
    } finally {
      client.release();
    }
    const again = await dump();
    for (const table of Object.keys(after))
      expect(again[table]!.map(canonical), table).toEqual(after[table]!.map(canonical));
  });

  it("leaves no function, trigger, view or constraint that reads an old name", async () => {
    // Renaming a column doesn't reach text that names it: a function body is kept as written and
    // read when it runs. Triggers, views and constraints are kept parsed, so they follow a rename;
    // they are read back here to make sure.
    const { rows } = await pool.query<{ what: string; text: string }>(`
      select 'function ' || p.proname as what, p.prosrc as text from pg_proc p
        where p.pronamespace = 'public'::regnamespace
      union all select 'trigger ' || t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
      union all select 'view ' || viewname, definition from pg_views where schemaname = 'public'
      union all select 'constraint ' || conname, pg_get_constraintdef(oid) from pg_constraint
        where connamespace = 'public'::regnamespace
      union all select 'index ' || indexname, indexdef from pg_indexes where schemaname = 'public'`);
    expect(rows.some((row) => row.what === "function runs_keep_legacy_usage")).toBe(true);
    const old = rows
      .filter((row) =>
        /\b(bots?|bot_ids?|bot_threads|owner_bot_id|created_by_bot_id|requested_by_bot_id|is_primary|desktop_takeovers|accounts)\b/.test(
          row.text,
        ),
      )
      .map((row) => row.what);
    expect(old).toEqual([]);
  });

  it("keeps a deleted run's legacy usage, under its teammate", async () => {
    await pool.query("delete from runs where id = $1", [LEGACY_RUN]);
    const { rows } = await pool.query(
      "select source_key, run_id, teammate_id, access_mode, input_tokens::int, cached_input_tokens::int, output_tokens::int from legacy_deleted_run_usage",
    );
    expect(rows).toEqual([
      {
        source_key: `run:${LEGACY_RUN}:plan`,
        run_id: LEGACY_RUN,
        teammate_id: REX,
        access_mode: "plan",
        input_tokens: 1200,
        cached_input_tokens: 300,
        output_tokens: 80,
      },
    ]);
  });

  it("deletes a teammate whose runs have legacy usage, and keeps that usage", async () => {
    const kit = "00000000-0000-4000-8000-00000000000c";
    const run = "00000000-0000-4000-8000-0000000000d3";
    await pool.query(
      "insert into teammates (id, name, slug, role, color) values ($1, 'Kit', 'kit', 'engineer', '#0ea5e9')",
      [kit],
    );
    await pool.query(
      "insert into chats (id, kind, title, teammate_id) values ($1, 'direct', 'Kit', $1)",
      [kit],
    );
    await pool.query(
      `insert into runs (id, chat_id, teammate_id, trigger, prompt, status, legacy_api_key_input_tokens,
         legacy_api_key_cached_input_tokens, legacy_api_key_output_tokens, legacy_api_key_cost_micros,
         legacy_usage_at) values ($1, $2, $3, 'user', 'Fix it', 'completed', 500, 0, 40, 1650, now())`,
      [run, kit, kit],
    );
    await pool.query("delete from teammates where id = $1", [kit]);
    const { rows } = await pool.query(
      "select teammate_id, access_mode, cost_micros::int from legacy_deleted_run_usage where run_id = $1",
      [run],
    );
    expect(rows).toEqual([{ teammate_id: kit, access_mode: "api_key", cost_micros: 1650 }]);
  });
});
