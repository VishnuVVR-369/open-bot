import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { createDb } from "@open-bot/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { MemoryService } from "./index";
import { MemoryAI, MemoryJobs, type MemoryAIConfig } from "./jobs";
import { memoryInputSchema } from "@open-bot/shared";

const connectionString = process.env.MEMORY_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
suite("memory with real Postgres", () => {
  const pool = new pg.Pool({ connectionString });
  const memory = new MemoryService(pool);
  let bot: string, peer: string, run: string, message: string, server: Server, url: string;
  let response: unknown = { data: [{ embedding: [1, 0, 0] }] };
  let requestCount = 0;
  let hold: (() => void) | undefined;
  const user = { kind: "user" as const };
  const input = (content: string, botId: string | null = bot) =>
    memoryInputSchema.parse({ content, botId });
  const config = (): MemoryAIConfig => ({
    embeddingUrl: url,
    embeddingModel: "test",
    embeddingDimensions: 3,
    extractionUrl: url,
    extractionModel: "test",
    dailyRequestLimit: 100,
  });
  beforeAll(async () => {
    if (
      !connectionString ||
      !/^openbot_memory_test(?:_[a-z0-9]+)?$/.test(new URL(connectionString).pathname.slice(1))
    )
      throw new Error("Memory tests require an isolated openbot_memory_test database.");
    await migrate(createDb(pool), {
      migrationsFolder: fileURLToPath(new URL("../../db/drizzle", import.meta.url)),
    });
    server = createServer(async (req, res) => {
      requestCount++;
      for await (const _ of req) {
        void _;
      }
      if (hold)
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    url = `http://127.0.0.1:${address.port}`;
  }, 30000);
  beforeEach(async () => {
    await pool.query(
      "truncate memory_items,memory_generations,memory_imports,memory_usage,bots cascade",
    );
    bot = randomUUID();
    peer = randomUUID();
    message = randomUUID();
    run = randomUUID();
    const chat = randomUUID();
    await pool.query("insert into settings(id) values(1) on conflict do nothing");
    await pool.query("update settings set about_me='' where id=1");
    await pool.query(
      "insert into bots(id,name,slug,role,color) values($1,'Tess','tess','assistant','#123456'),($2,'Peer','peer','assistant','#123456')",
      [bot, peer],
    );
    await pool.query(
      "insert into chats(id,kind,title,bot_id) values($1,'direct','Memory tests',$2)",
      [chat, bot],
    );
    await pool.query(
      "insert into messages(id,chat_id,role,text) values($1,$2,'user','Please remember I prefer remote jobs.')",
      [message, chat],
    );
    await pool.query(
      "insert into runs(id,chat_id,bot_id,trigger,prompt,message_id,status) values($1,$2,$3,'user','Please remember I prefer remote jobs.',$4,'completed')",
      [run, chat, bot, message],
    );
    response = { data: [{ embedding: [1, 0, 0] }] };
    requestCount = 0;
    hold = undefined;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it("saves atomically with source, revision, job and generation", async () => {
    const before = await memory.generation(bot);
    const saved = await memory.save(input("Prefers remote roles"), user);
    expect(saved.revision).toBe(1);
    expect(await memory.history(saved.id, user)).toHaveLength(1);
    expect(
      (await pool.query("select * from memory_jobs where memory_id=$1", [saved.id])).rowCount,
    ).toBe(1);
    expect(await memory.generation(bot)).not.toBe(before);
  });
  it("deduplicates retry and concurrent saves", async () => {
    const items = await Promise.all(
      Array.from({ length: 5 }, () => memory.save(input("Prefers remote roles"), user)),
    );
    expect(new Set(items.map((i) => i.id)).size).toBe(1);
    expect(items.filter((i) => i.saveOutcome === "created")).toHaveLength(1);
    expect(items.filter((i) => i.saveOutcome === "unchanged")).toHaveLength(4);
    expect(await memory.list({ botId: bot }, user)).toHaveLength(1);
  });
  it("rejects one of two competing edits and preserves the winning revision", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    const results = await Promise.allSettled(
      ["Prefers hybrid roles", "Prefers local roles"].map((content) =>
        memory.update({ ...saved, content, expectedRevision: 1 }, user),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await memory.history(saved.id, user)).toHaveLength(2);
  });
  it("restores as a new revision", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    await memory.update({ ...saved, content: "Prefers hybrid roles", expectedRevision: 1 }, user);
    const restored = await memory.restore({ id: saved.id, expectedRevision: 2, revision: 1 });
    expect(restored.revision).toBe(3);
    expect(restored.content).toBe(saved.content);
  });
  it("scopes recall and cannot leak a peer's memory through IDs", async () => {
    const shared = await memory.save(input("Shared dietary preference", null), user);
    const own = await memory.save(input("Own dietary preference"), user);
    const privateItem = await memory.save(input("Peer dietary preference", peer), user);
    expect((await memory.recall(bot, "dietary preference")).map((i) => i.id).sort()).toEqual(
      [own.id, shared.id].sort(),
    );
    await expect(
      memory.history(privateItem.id, { kind: "bot", botId: bot, runId: run }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      memory.forget(
        { id: privateItem.id, expectedRevision: 1 },
        { kind: "bot", botId: bot, runId: run },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps inferred facts out of recall until confirmed", async () => {
    const saved = await memory.save(input("Prefers remote roles"), {
      kind: "bot",
      botId: bot,
      runId: run,
      messageId: message,
    });
    expect(saved.state).toBe("candidate");
    expect(await memory.recall(bot, "remote")).toHaveLength(0);
    await memory.approve({ id: saved.id, expectedRevision: 1 });
    expect(await memory.recall(bot, "remote")).toHaveLength(1);
  });
  it("prevents unverified writes to shared memory and confirmed facts", async () => {
    await expect(
      memory.save(input("Shared preference", null), { kind: "bot", botId: bot, runId: run }),
    ).rejects.toMatchObject({ status: 403 });
    const saved = await memory.save(input("Prefers remote roles"), user);
    await expect(
      memory.update(
        { ...saved, content: "Actually likes offices", expectedRevision: 1 },
        { kind: "bot", botId: bot, runId: run },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("confirms a suggestion when the user explicitly saves the same fact", async () => {
    const candidate = await memory.save(input("Prefers remote roles"), {
      kind: "bot",
      botId: bot,
      runId: run,
      messageId: message,
    });
    const saved = await memory.save(input("Prefers remote roles"), user);
    expect(saved.id).toBe(candidate.id);
    expect(saved.state).toBe("active");
    expect(saved.revision).toBe(2);
    expect(saved.saveOutcome).toBe("confirmed");
  });
  it("uses the explicit save metadata when confirming an expired suggestion", async () => {
    const candidate = await memory.save(
      { ...input("Prefers remote roles"), key: "old.topic" },
      { kind: "bot", botId: bot, runId: run },
    );
    await pool.query("update memory_items set expires_at=now()-interval '1 second' where id=$1", [
      candidate.id,
    ]);
    const saved = await memory.save(
      {
        ...input("Prefers remote roles"),
        kind: "preference",
        key: "career.location",
        pinned: true,
      },
      user,
    );
    expect(saved).toMatchObject({
      id: candidate.id,
      state: "active",
      revision: 2,
      kind: "preference",
      key: "career.location",
      pinned: true,
      expiresAt: null,
    });
    expect(await memory.recall(bot, "remote")).toHaveLength(1);
  });
  it("checks the submitted topic key before confirming a duplicate suggestion", async () => {
    await memory.save({ ...input("Prefers local roles"), key: "career.location" }, user);
    const candidate = await memory.save(input("Prefers remote roles"), {
      kind: "bot",
      botId: bot,
      runId: run,
    });
    await expect(
      memory.save({ ...input("Prefers remote roles"), key: "career.location" }, user),
    ).rejects.toMatchObject({ status: 409 });
    expect((await memory.get(candidate.id, user)).state).toBe("candidate");
  });
  it("requires verified user intent even for forgetting the bot's own memory", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    await expect(
      memory.forget({ id: saved.id, expectedRevision: 1 }, { kind: "bot", botId: bot, runId: run }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("requires explicit correction when a topic key conflicts", async () => {
    await memory.save({ ...input("Prefers remote roles"), key: "career.location" }, user);
    await expect(
      memory.save({ ...input("Prefers local roles"), key: "career.location" }, user),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("includes pinned facts without an unrelated recent-memory fallback", async () => {
    await memory.save({ ...input("Vegetarian"), pinned: true }, user);
    await memory.save(input("Prefers remote roles"), user);
    expect((await memory.recall(bot, "astronomy")).map((i) => i.content)).toEqual(["Vegetarian"]);
  });
  it("finds relevant facts from a full natural-language request and topic keys", async () => {
    await memory.save(
      { ...input("Vegetarian; allergic to peanuts."), key: "diet.allergies" },
      user,
    );
    expect(
      await memory.recall(bot, "Without searching the internet, what am I allergic to?"),
    ).toHaveLength(1);
    expect(await memory.recall(bot, "diet allergies")).toHaveLength(1);
  });
  it("does not force unrelated semantic neighbors into the context", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    await pool.query("insert into memory_embeddings values($1,1,'test:3','[0,1,0]')", [saved.id]);
    expect(
      await memory.recall(bot, "astronomy", { vector: [1, 0, 0], model: "test:3" }),
    ).toHaveLength(0);
  });
  it("restores metadata as well as the saved content", async () => {
    const saved = await memory.save(
      { ...input("Prefers remote roles"), pinned: true, key: "career.location" },
      user,
    );
    await memory.update(
      {
        ...saved,
        pinned: false,
        key: "career.updated",
        content: "Prefers hybrid roles",
        expectedRevision: 1,
      },
      user,
    );
    const restored = await memory.restore({ id: saved.id, expectedRevision: 2, revision: 1 });
    expect(restored.pinned).toBe(true);
    expect(restored.key).toBe("career.location");
  });
  it("does lexical search with exact names and literal wildcard characters", async () => {
    await memory.save(input("Works with Project Falcon"), user);
    await memory.save(input("Target is 100% remote"), user);
    expect(await memory.list({ botId: bot, query: "Falcon" }, user)).toHaveLength(1);
    expect(await memory.list({ botId: bot, query: "100%" }, user)).toHaveLength(1);
  });
  it("rejects expired inputs and invalidates context when a fact expires", async () => {
    await expect(
      memory.save({ ...input("Temporary fact"), expiresAt: new Date(0).toISOString() }, user),
    ).rejects.toMatchObject({ status: 400 });
    const saved = await memory.save(input("Temporary fact"), user);
    const generation = await memory.generation(bot);
    await pool.query("update memory_items set expires_at=now()-interval '1 second' where id=$1", [
      saved.id,
    ]);
    expect(await memory.recall(bot, "Temporary")).toHaveLength(0);
    expect(await memory.generation(bot)).not.toBe(generation);
    expect(await memory.list({ botId: bot, includeExpired: true }, user)).toHaveLength(1);
  });
  it("marks affected executing runs for cancellation on corrections", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    await pool.query("update runs set status='running' where id=$1", [run]);
    await memory.update({ ...saved, content: "Prefers hybrid roles", expectedRevision: 1 }, user);
    expect(
      (await pool.query("select cancel_requested_at from runs where id=$1", [run])).rows[0]
        .cancel_requested_at,
    ).not.toBeNull();
  });
  it("forgets history, vectors and jobs, retaining a non-content tombstone", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    await pool.query("insert into memory_embeddings values($1,1,'test:3','[1,0,0]')", [saved.id]);
    await memory.forget({ id: saved.id, expectedRevision: 1 }, user);
    for (const table of ["memory_revisions", "memory_embeddings", "memory_jobs"])
      expect(
        (await pool.query(`select * from ${table} where memory_id=$1`, [saved.id])).rowCount,
      ).toBe(0);
    expect(
      (await pool.query("select content,state from memory_items where id=$1", [saved.id])).rows[0],
    ).toEqual({ content: "", state: "deleted" });
    await expect(memory.history(saved.id, user)).rejects.toMatchObject({ status: 404 });
    await expect(
      memory.save(input("Prefers remote roles"), { kind: "bot", botId: bot, runId: run }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not relearn a forgotten source under a paraphrase", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user, {
      source: { type: "bot", messageId: message, runId: run },
    });
    await memory.forget({ id: saved.id, expectedRevision: 1 }, user);
    await expect(
      memory.save(input("Would like to work from home"), {
        kind: "bot",
        botId: bot,
        runId: run,
        messageId: message,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("imports legacy data once and does not resurrect forgotten notes", async () => {
    await pool.query("update settings set about_me='Lives in Lisbon' where id=1");
    await memory.importLegacy();
    await memory.importLegacy();
    const items = await memory.list({ botId: null }, user);
    expect(items).toHaveLength(1);
    await memory.forget({ id: items[0]!.id, expectedRevision: 1 }, user);
    await memory.importLegacy();
    expect(await memory.list({ botId: null }, user)).toHaveLength(0);
  });
  it("marks an empty legacy profile imported before new shared facts exist", async () => {
    await memory.importLegacy();
    await memory.save(input("Lives in Lisbon", null), user);
    await memory.importLegacy();
    expect(await memory.list({ botId: null }, user)).toHaveLength(1);
  });
  it("imports every legacy lesson before maintaining its compatibility view", async () => {
    await pool.query(
      "insert into lessons(bot_id,text) values($1,'Use concise replies'),($1,'Use citations')",
      [bot],
    );
    await memory.importLegacy();
    await memory.save(input("Prefers remote roles"), user);
    expect((await pool.query("select text from lessons where bot_id=$1", [bot])).rows).toHaveLength(
      2,
    );
  });
  it("keeps shared memory scalable while bounding the compatibility profile", async () => {
    await memory.save(input("x".repeat(7999), null), user);
    await memory.save(input("another shared fact", null), user);
    expect(await memory.list({ botId: null }, user)).toHaveLength(2);
    expect(
      (await pool.query("select about_me from settings where id=1")).rows[0].about_me.length,
    ).toBeLessThanOrEqual(8000);
  });
  it("rolls back memory and revision if outbox insertion fails", async () => {
    await pool.query(
      "create function memory_test_fail_job() returns trigger language plpgsql as $$ begin raise exception 'test fault'; end $$",
    );
    await pool.query(
      "create trigger memory_test_job_failure before insert on memory_jobs for each row execute function memory_test_fail_job()",
    );
    try {
      await expect(memory.save(input("A transaction that must roll back"), user)).rejects.toThrow(
        "test fault",
      );
      expect(await memory.list({ botId: bot }, user)).toHaveLength(0);
      expect((await pool.query("select * from memory_revisions")).rowCount).toBe(0);
    } finally {
      await pool.query("drop trigger memory_test_job_failure on memory_jobs");
      await pool.query("drop function memory_test_fail_job()");
    }
  });
  it("combines semantic and lexical recall while ignoring stale vectors", async () => {
    const semantic = await memory.save(input("Enjoys working from home"), user);
    const lexical = await memory.save(input("Prefers remote jobs"), user);
    await pool.query(
      "insert into memory_embeddings values($1,1,'test:3','[1,0,0]'),($2,1,'test:3','[0,1,0]')",
      [semantic.id, lexical.id],
    );
    const results = await memory.recall(bot, "remote", { vector: [1, 0, 0], model: "test:3" });
    expect(results.map((i) => i.id)).toContain(semantic.id);
    expect(results.map((i) => i.id)).toContain(lexical.id);
    await memory.update(
      { ...semantic, content: "Prefers working at an office", expectedRevision: 1 },
      user,
    );
    expect(
      (await pool.query("select * from memory_embeddings where memory_id=$1", [semantic.id]))
        .rowCount,
    ).toBe(0);
  });
  it("indexes a current revision through an actual compatible HTTP endpoint", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    const jobs = new MemoryJobs(memory, new MemoryAI(pool, config()));
    await jobs.tick();
    const { rows } = await pool.query(
      "select revision,model from memory_embeddings where memory_id=$1",
      [saved.id],
    );
    expect(rows[0]).toEqual({ revision: 1, model: "test:3" });
    expect(requestCount).toBe(1);
  });
  it("does not recreate vectors when forgotten during an embedding request", async () => {
    const saved = await memory.save(input("Prefers remote roles"), user);
    const jobs = new MemoryJobs(memory, new MemoryAI(pool, config()));
    hold = () => {};
    const tick = jobs.tick();
    await expect.poll(() => requestCount).toBe(1);
    await memory.forget({ id: saved.id, expectedRevision: 1 }, user);
    hold!();
    hold = undefined;
    await tick;
    expect((await pool.query("select * from memory_embeddings")).rowCount).toBe(0);
  });
  it("extracts only supported quotes as bot-scoped suggestions", async () => {
    response = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              memories: [
                {
                  content: "Prefers remote jobs",
                  kind: "preference",
                  evidence: "I prefer remote jobs",
                },
                {
                  content: "Likes offices",
                  kind: "preference",
                  evidence: "a fabricated quotation",
                },
              ],
            }),
          },
        },
      ],
    };
    await memory.queueExtraction(run);
    const cfg = config();
    delete cfg.embeddingUrl;
    await new MemoryJobs(memory, new MemoryAI(pool, cfg)).tick();
    const items = await memory.list({ botId: bot, candidates: true }, user);
    expect(items).toHaveLength(1);
    expect(items[0]!.state).toBe("candidate");
    expect(items[0]!.source.messageId).toBe(message);
  });
  it("defers budget-exhausted jobs without exhausting their retry allowance", async () => {
    await memory.save(input("Prefers remote roles"), user);
    await pool.query("insert into memory_usage(day,requests) values(current_date,1)");
    await new MemoryJobs(memory, new MemoryAI(pool, { ...config(), dailyRequestLimit: 1 })).tick();
    const { rows } = await pool.query(
      "select attempts,available_at>now() as deferred from memory_jobs",
    );
    expect(rows[0]).toEqual({ attempts: 0, deferred: true });
    expect(requestCount).toBe(0);
  });
  it("duplicates all notes beyond the UI page size without copying shared memory", async () => {
    for (let index = 0; index < 205; index++)
      await memory.save(input(`Copy note number ${index}`), user);
    await memory.save(input("A shared fact", null), user);
    await memory.copyBot(bot, peer);
    await memory.copyBot(bot, peer);
    const items = await memory.list({ botId: peer, limit: 1000 }, user);
    expect(items).toHaveLength(205);
    expect(items.every((item) => item.source.type === "import")).toBe(true);
  }, 10000);
  it("does not call an endpoint when disabled and enforces the daily request limit", async () => {
    const disabled = new MemoryAI(pool, { ...config(), dailyRequestLimit: 0 });
    expect(await disabled.embed("fact")).toBeUndefined();
    expect(requestCount).toBe(0);
    const ai = new MemoryAI(pool, { ...config(), dailyRequestLimit: 1 });
    await ai.embed("fact");
    await expect(ai.embed("fact")).rejects.toThrow("limit");
    expect(requestCount).toBe(1);
  });
});
