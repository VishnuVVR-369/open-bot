import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  memoryInputSchema,
  memoryEditSchema,
  memoryReferenceSchema,
  normalizeMemory,
  type MemoryInput,
  type MemoryItem,
  type MemoryRevision,
  type MemorySource,
} from "@open-bot/shared";

export class MemoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type MemoryActor =
  | { kind: "user" }
  | { kind: "import" }
  | {
      kind: "bot";
      botId: string;
      runId: string;
      messageId?: string;
      verified?: boolean;
      allowShared?: boolean;
    };
export type MemorySaveResult = MemoryItem & {
  saveOutcome: "created" | "confirmed" | "unchanged";
};
interface Row {
  id: string;
  bot_id: string | null;
  kind: MemoryItem["kind"];
  content: string;
  key: string | null;
  fingerprint: string;
  revision: number;
  state: MemoryItem["state"];
  pinned: boolean;
  expires_at: Date | null;
  source: MemorySource;
  created_at: Date;
  updated_at: Date;
  legacy_key: string | null;
}
export function itemView(row: Row): MemoryItem {
  return {
    id: row.id,
    botId: row.bot_id,
    kind: row.kind,
    content: row.content,
    key: row.key,
    revision: row.revision,
    state: row.state,
    pinned: row.pinned,
    expiresAt: row.expires_at?.toISOString() ?? null,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export function fingerprint(content: string): string {
  return createHash("sha256").update(normalizeMemory(content)).digest("hex");
}
function sourceOf(actor: MemoryActor): MemorySource {
  return actor.kind === "bot"
    ? {
        type: "bot",
        runId: actor.runId,
        ...(actor.messageId ? { messageId: actor.messageId } : {}),
      }
    : { type: actor.kind === "import" ? "import" : "user" };
}
function canRead(actor: MemoryActor, botId: string | null): boolean {
  return actor.kind !== "bot" || botId === null || botId === actor.botId;
}
function canWrite(actor: MemoryActor, botId: string | null): boolean {
  return (
    actor.kind !== "bot" ||
    botId === actor.botId ||
    (botId === null && (actor.verified === true || actor.allowShared === true))
  );
}
function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new MemoryError(400, result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}
const scopeOf = (botId: string | null) => (botId ? `bot:${botId}` : "shared");

/** Canonical memory. Both web actions and agent tools use these transactions. */
export class MemoryService {
  constructor(readonly pool: pg.Pool) {}

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await fn(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockScope(client: pg.PoolClient, botId: string | null) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [scopeOf(botId)]);
    if (botId) {
      const result = await client.query(
        "select id from bots where id = $1 and archived_at is null",
        [botId],
      );
      if (!result.rowCount) throw new MemoryError(404, "That teammate no longer exists.");
    }
  }

  private async revision(client: pg.PoolClient, row: Row) {
    const { pinned, key, kind, expires_at, state } = row;
    await client.query(
      `insert into memory_revisions(memory_id, revision, content, snapshot, source)
      values($1,$2,$3,$4,$5)`,
      [
        row.id,
        row.revision,
        row.content,
        { pinned, key, kind, expiresAt: expires_at, state },
        row.source,
      ],
    );
    if (row.state === "active")
      await client.query(
        `insert into memory_jobs(kind,memory_id,revision,dedupe_key)
      values('embed',$1,$2,$3) on conflict(dedupe_key) do nothing`,
        [row.id, row.revision, `embed:${row.id}:${row.revision}`],
      );
  }

  /** Legacy tables are compatibility views maintained transactionally, never independent writers. */
  private async changed(
    client: pg.PoolClient,
    botId: string | null,
    actor: MemoryActor,
    contextChanged: boolean,
  ) {
    if (contextChanged) {
      await client.query(
        `insert into memory_generations(scope,generation) values($1,1)
        on conflict(scope) do update set generation = memory_generations.generation + 1`,
        [scopeOf(botId)],
      );
      // Mark stale active turns durably. The worker also receives a wakeup, including across processes.
      await client.query(
        `update runs set cancel_requested_at = now()
        where status in ('starting','running','waiting') and ($1::uuid is null or bot_id = $1)
          and ($2::uuid is null or id <> $2)`,
        [botId, actor.kind === "bot" ? actor.runId : null],
      );
      await client.query("select pg_notify('openbot_worker','cancel')");
    }
    if (botId) {
      await client.query("delete from lessons where bot_id = $1", [botId]);
      await client.query(
        `insert into lessons(id,bot_id,run_id,text,created_at)
        select id,bot_id,(select id from runs where id::text=source->>'runId'),content,created_at from memory_items
        where bot_id=$1 and kind='lesson' and state='active' and (expires_at is null or expires_at>now())`,
        [botId],
      );
      await client.query("update bots set lessons_changed_at=now() where id=$1", [botId]);
    } else {
      const { rows } = await client.query<{ content: string }>(`select content from memory_items
        where bot_id is null and state='active' and (expires_at is null or expires_at>now()) order by created_at,id`);
      // Keep the old profile API bounded without imposing its old size limit on canonical memory.
      const profile = rows
        .map((r) => r.content)
        .join("\n")
        .slice(0, 8000);
      await client.query(
        `insert into settings(id,about_me,about_me_updated_at) values(1,$1,now())
        on conflict(id) do update set about_me=$1, about_me_updated_at=now()`,
        [profile],
      );
    }
    for (const type of ["memory", "profile", "lessons"])
      await client.query("select pg_notify('openbot_app',$1)", [JSON.stringify({ type })]);
  }

  async save(
    input: MemoryInput,
    actor: MemoryActor,
    options: { source?: MemorySource; legacyKey?: string; id?: string } = {},
  ): Promise<MemorySaveResult> {
    const data = validate(memoryInputSchema, input);
    if (!canWrite(actor, data.botId))
      throw new MemoryError(
        403,
        "You can only save your own memories. Shared facts need an explicit user statement.",
      );
    if (data.expiresAt && new Date(data.expiresAt) <= new Date())
      throw new MemoryError(400, "Choose a future expiry.");
    return this.transaction(async (client) => {
      await this.lockScope(client, data.botId);
      const hash = fingerprint(data.content);
      if (actor.kind === "bot") {
        const blocked = await client.query(
          "select key from memory_imports where key=any($1::text[])",
          [
            [
              `forgotten:${scopeOf(data.botId)}:${hash}`,
              ...(actor.messageId ? [`forget-source:${actor.messageId}`] : []),
            ],
          ],
        );
        if (blocked.rowCount && !actor.verified)
          throw new MemoryError(409, "This source or memory was forgotten. Do not learn it again.");
      }
      const existing = await client.query<Row>(
        `select * from memory_items where bot_id is not distinct from $1
        and fingerprint=$2 order by (state='deleted') asc limit 1`,
        [data.botId, hash],
      );
      const known = existing.rows[0];
      if (known && known.state !== "deleted") {
        if (known.state === "candidate" && (actor.kind !== "bot" || actor.verified)) {
          if (data.key) {
            const conflict = await client.query(
              "select id from memory_items where bot_id is not distinct from $1 and key=$2 and state='active' and id<>$3",
              [known.bot_id, data.key, known.id],
            );
            if (conflict.rowCount)
              throw new MemoryError(
                409,
                "This suggestion conflicts with a confirmed memory. Edit that memory instead.",
              );
          }
          const { rows } = await client.query<Row>(
            `update memory_items set state='active',revision=revision+1,source=$2,updated_at=now(),
              content=$3,kind=$4,key=$5,pinned=$6,expires_at=$7 where id=$1 returning *`,
            [
              known.id,
              options.source ?? sourceOf(actor),
              data.content,
              data.kind,
              data.key,
              actor.kind === "bot" ? false : data.pinned,
              data.expiresAt,
            ],
          );
          await this.revision(client, rows[0]!);
          await this.changed(client, known.bot_id, actor, true);
          return { ...itemView(rows[0]!), saveOutcome: "confirmed" };
        }
        return { ...itemView(known), saveOutcome: "unchanged" };
      }
      if (known && actor.kind === "bot" && !actor.verified)
        throw new MemoryError(
          409,
          "This memory was forgotten. Do not save it again from old context.",
        );
      if (data.key) {
        const clash = await client.query(
          `select id from memory_items where bot_id is not distinct from $1 and key=$2 and state='active'`,
          [data.botId, data.key],
        );
        if (clash.rowCount)
          throw new MemoryError(
            409,
            "A memory with this key exists. Recall it and update its expected revision instead.",
          );
      }
      const state = actor.kind === "bot" && !actor.verified ? "candidate" : "active";
      const { rows } = await client.query<Row>(
        `insert into memory_items(id,bot_id,kind,content,key,fingerprint,state,pinned,expires_at,source,legacy_key)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [
          options.id ?? randomUUID(),
          data.botId,
          data.kind,
          data.content,
          data.key,
          hash,
          state,
          actor.kind === "bot" ? false : data.pinned,
          data.expiresAt,
          options.source ?? sourceOf(actor),
          options.legacyKey ?? null,
        ],
      );
      const row = rows[0]!;
      await this.revision(client, row);
      await this.changed(client, data.botId, actor, state === "active");
      return { ...itemView(row), saveOutcome: "created" };
    });
  }

  private async getLocked(client: pg.PoolClient, id: string, actor: MemoryActor): Promise<Row> {
    // Scope lock is acquired before the row lock by every writer, avoiding lock-order inversions.
    const first = await client.query<Row>("select * from memory_items where id=$1", [id]);
    if (!first.rows[0] || !canRead(actor, first.rows[0].bot_id))
      throw new MemoryError(404, "Memory not found.");
    await this.lockScope(client, first.rows[0].bot_id);
    const { rows } = await client.query<Row>("select * from memory_items where id=$1 for update", [
      id,
    ]);
    if (!rows[0] || rows[0].state === "deleted") throw new MemoryError(404, "Memory not found.");
    if (!canWrite(actor, rows[0].bot_id))
      throw new MemoryError(403, "Only the user can change this shared memory.");
    return rows[0];
  }

  async update(
    input: z.infer<typeof memoryEditSchema>,
    actor: MemoryActor,
    options: { allowExpired?: boolean } = {},
  ): Promise<MemoryItem> {
    const data = validate(memoryEditSchema, input);
    return this.transaction(async (client) => {
      const old = await this.getLocked(client, data.id, actor);
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it before saving.");
      if (old.bot_id !== data.botId)
        throw new MemoryError(400, "Scope cannot be changed. Save a separate memory instead.");
      if (actor.kind === "bot" && !actor.verified && old.state === "active")
        throw new MemoryError(
          403,
          "An inference cannot replace a confirmed memory. Suggest a new candidate.",
        );
      if (!options.allowExpired && data.expiresAt && new Date(data.expiresAt) <= new Date())
        throw new MemoryError(400, "Choose a future expiry.");
      const hash = fingerprint(data.content);
      const clashes = await client.query(
        `select id from memory_items where bot_id is not distinct from $1 and id<>$2
        and state<>'deleted' and (fingerprint=$3 or ($4::text is not null and key=$4 and state='active'))`,
        [old.bot_id, old.id, hash, data.key],
      );
      if (clashes.rowCount)
        throw new MemoryError(409, "Another memory already has this content or key.");
      const { rows } = await client.query<Row>(
        `update memory_items set content=$2,kind=$3,key=$4,fingerprint=$5,pinned=$6,expires_at=$7,
        revision=revision+1,updated_at=now(),source=$8 where id=$1 returning *`,
        [
          old.id,
          data.content,
          data.kind,
          data.key,
          hash,
          data.pinned,
          data.expiresAt,
          sourceOf(actor),
        ],
      );
      await client.query("delete from memory_embeddings where memory_id=$1", [old.id]);
      await this.revision(client, rows[0]!);
      await this.changed(client, old.bot_id, actor, old.state === "active");
      return itemView(rows[0]!);
    });
  }

  async approve(input: z.infer<typeof memoryReferenceSchema>): Promise<MemoryItem> {
    const data = validate(memoryReferenceSchema, input);
    return this.transaction(async (client) => {
      const old = await this.getLocked(client, data.id, { kind: "user" });
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it first.");
      if (old.state !== "candidate")
        throw new MemoryError(409, "This memory is already confirmed.");
      if (old.expires_at && old.expires_at <= new Date())
        throw new MemoryError(409, "This suggestion expired.");
      if (old.key) {
        const clash = await client.query(
          `select id from memory_items where bot_id is not distinct from $1 and key=$2 and state='active' and id<>$3`,
          [old.bot_id, old.key, old.id],
        );
        if (clash.rowCount)
          throw new MemoryError(
            409,
            "This conflicts with a confirmed memory. Edit that memory instead.",
          );
      }
      const { rows } = await client.query<Row>(
        `update memory_items set state='active',revision=revision+1,updated_at=now() where id=$1 returning *`,
        [old.id],
      );
      await this.revision(client, rows[0]!);
      await this.changed(client, old.bot_id, { kind: "user" }, true);
      return itemView(rows[0]!);
    });
  }

  async forget(input: z.infer<typeof memoryReferenceSchema>, actor: MemoryActor): Promise<void> {
    const data = validate(memoryReferenceSchema, input);
    await this.transaction(async (client) => {
      const old = await this.getLocked(client, data.id, actor);
      if (actor.kind === "bot" && !actor.verified)
        throw new MemoryError(403, "Only forget memory when the user explicitly asks.");
      if (old.revision !== data.expectedRevision)
        throw new MemoryError(409, "This memory changed. Reload it before forgetting.");
      const previous = await client.query<{ content: string; source: MemorySource }>(
        "select content,source from memory_revisions where memory_id=$1",
        [old.id],
      );
      for (const revision of previous.rows) {
        await client.query("insert into memory_imports(key) values($1) on conflict do nothing", [
          `forgotten:${scopeOf(old.bot_id)}:${fingerprint(revision.content)}`,
        ]);
        if (revision.source.messageId)
          await client.query("insert into memory_imports(key) values($1) on conflict do nothing", [
            `forget-source:${revision.source.messageId}`,
          ]);
      }
      await client.query(
        `update memory_items set content='', key=null,state='deleted',source='{}',revision=revision+1,
        pinned=false,expires_at=null,updated_at=now() where id=$1`,
        [old.id],
      );
      await client.query("delete from memory_revisions where memory_id=$1", [old.id]);
      await client.query("delete from memory_embeddings where memory_id=$1", [old.id]);
      await client.query("delete from memory_jobs where memory_id=$1", [old.id]);
      await this.changed(client, old.bot_id, actor, old.state === "active");
    });
  }

  /** Duplicate all confirmed, unexpired bot notes, without copying shared facts or private history. */
  async copyBot(fromBotId: string, toBotId: string): Promise<void> {
    validate(z.string().uuid(), fromBotId);
    validate(z.string().uuid(), toBotId);
    if (fromBotId === toBotId)
      throw new MemoryError(400, "Choose a different teammate for the copy.");
    await this.transaction(async (client) => {
      for (const id of [fromBotId, toBotId].sort()) await this.lockScope(client, id);
      const source = await client.query<Row>(
        "select * from memory_items where bot_id=$1 and state='active' and kind<>'lesson' and (expires_at is null or expires_at>now()) order by created_at,id",
        [fromBotId],
      );
      let changed = false;
      for (const item of source.rows) {
        const duplicate = await client.query(
          "select id from memory_items where bot_id=$1 and fingerprint=$2 and state<>'deleted'",
          [toBotId, item.fingerprint],
        );
        if (duplicate.rowCount) continue;
        const { rows } = await client.query<Row>(
          `insert into memory_items(bot_id,kind,content,key,fingerprint,pinned,expires_at,source)
          values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [
            toBotId,
            item.kind,
            item.content,
            item.key,
            item.fingerprint,
            item.pinned,
            item.expires_at,
            { type: "import" },
          ],
        );
        await this.revision(client, rows[0]!);
        changed = true;
      }
      if (changed) await this.changed(client, toBotId, { kind: "user" }, true);
    });
  }

  async get(id: string, actor: MemoryActor): Promise<MemoryItem> {
    validate(z.string().uuid(), id);
    const { rows } = await this.pool.query<Row>(
      "select * from memory_items where id=$1 and state<>'deleted'",
      [id],
    );
    if (!rows[0] || !canRead(actor, rows[0].bot_id))
      throw new MemoryError(404, "Memory not found.");
    return itemView(rows[0]);
  }

  async history(id: string, actor: MemoryActor): Promise<MemoryRevision[]> {
    validate(z.string().uuid(), id);
    const { rows } = await this.pool.query<Row>(
      "select * from memory_items where id=$1 and state<>'deleted'",
      [id],
    );
    if (!rows[0] || !canRead(actor, rows[0].bot_id))
      throw new MemoryError(404, "Memory not found.");
    const result = await this.pool.query<{
      revision: number;
      content: string;
      snapshot: { state: MemoryItem["state"] };
      source: MemorySource;
      created_at: Date;
    }>(
      "select revision,content,snapshot,source,created_at from memory_revisions where memory_id=$1 order by revision desc",
      [id],
    );
    return result.rows.map((r) => ({
      revision: r.revision,
      content: r.content,
      state: r.snapshot.state,
      source: r.source,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async restore(input: {
    id: string;
    expectedRevision: number;
    revision: number;
  }): Promise<MemoryItem> {
    const revisions = await this.history(input.id, { kind: "user" });
    const target = revisions.find((r) => r.revision === input.revision);
    if (!target) throw new MemoryError(404, "That revision no longer exists.");
    const { rows } = await this.pool.query<Row>("select * from memory_items where id=$1", [
      input.id,
    ]);
    const current = itemView(rows[0]!);
    const snapshot = await this.pool.query<{
      snapshot: {
        kind: MemoryItem["kind"];
        key: string | null;
        pinned: boolean;
        expiresAt: string | null;
      };
    }>("select snapshot from memory_revisions where memory_id=$1 and revision=$2", [
      input.id,
      input.revision,
    ]);
    const metadata = snapshot.rows[0]?.snapshot;
    if (!metadata) throw new MemoryError(404, "That revision no longer exists.");
    return this.update(
      {
        ...current,
        ...metadata,
        content: target.content,
        expectedRevision: input.expectedRevision,
      },
      { kind: "user" },
      { allowExpired: true },
    );
  }

  async list(
    options: {
      botId: string | null;
      includeShared?: boolean;
      query?: string;
      candidates?: boolean;
      includeExpired?: boolean;
      limit?: number;
    },
    actor: MemoryActor,
  ): Promise<MemoryItem[]> {
    if (options.botId) validate(z.string().uuid(), options.botId);
    if (!canRead(actor, options.botId)) throw new MemoryError(404, "Memory not found.");
    const query = (options.query ?? "").trim().slice(0, 500);
    const { rows } = await this.pool.query<Row>(
      `select * from memory_items where
      (bot_id is not distinct from $1::uuid or ($2 and bot_id is null)) and state=any($3::text[])
      and ($5 or expires_at is null or expires_at>now())
      and ($4='' or to_tsvector('english',content || ' ' || regexp_replace(coalesce(key,''),'[^[:alnum:]]+',' ','g')) @@ websearch_to_tsquery('english',$4) or content ilike '%' || replace(replace(replace($4,'\\','\\\\'),'%','\\%'),'_','\\_') || '%')
      order by pinned desc,updated_at desc,id limit $6`,
      [
        options.botId,
        options.includeShared ?? false,
        options.candidates ? ["active", "candidate"] : ["active"],
        query,
        options.includeExpired ?? false,
        Math.max(1, Math.min(options.limit ?? 200, 10001)),
      ],
    );
    return rows.map(itemView);
  }

  async generation(botId: string): Promise<string> {
    const { rows } = await this.pool.query<{ scope: string; generation: number }>(
      "select * from memory_generations where scope=any($1)",
      [["shared", scopeOf(botId)]],
    );
    const expired = await this.pool.query<{ count: string }>(
      `select count(*) from memory_items where (bot_id=$1 or bot_id is null) and state='active' and expires_at<=now()`,
      [botId],
    );
    return `${rows.find((r) => r.scope === "shared")?.generation ?? 0}:${rows.find((r) => r.scope === scopeOf(botId))?.generation ?? 0}:${expired.rows[0]!.count}`;
  }

  async recall(
    botId: string,
    query: string,
    options: { vector?: number[]; model?: string; maxDistance?: number } = {},
  ): Promise<MemoryItem[]> {
    validate(z.string().uuid(), botId);
    const q = query.slice(0, 1000);
    const lexical = await this.pool.query<Row>(
      `with query as (select to_tsquery('english',replace(plainto_tsquery('english',$2)::text,' & ',' | ')) as terms)
      select memory_items.*,ts_rank_cd(to_tsvector('english',content || ' ' || regexp_replace(coalesce(key,''),'[^[:alnum:]]+',' ','g')),query.terms) as rank
      from memory_items cross join query where (bot_id=$1 or bot_id is null) and state='active' and (expires_at is null or expires_at>now())
      and (pinned or to_tsvector('english',content || ' ' || regexp_replace(coalesce(key,''),'[^[:alnum:]]+',' ','g')) @@ query.terms)
      order by pinned desc,rank desc,updated_at desc,id limit 30`,
      [botId, q],
    );
    let semantic: Row[] = [];
    if (options.vector?.length && options.model) {
      const result = await this.pool.query<Row>(
        `select m.* from memory_items m join memory_embeddings e on e.memory_id=m.id and e.revision=m.revision
        where (m.bot_id=$1 or m.bot_id is null) and m.state='active' and (m.expires_at is null or m.expires_at>now())
          and e.model=$2 and vector_dims(e.embedding)=$3 and (e.embedding <=> $4::vector) <= $5
        order by e.embedding <=> $4::vector limit 30`,
        [
          botId,
          options.model,
          options.vector.length,
          JSON.stringify(options.vector),
          options.maxDistance ?? 0.4,
        ],
      );
      semantic = result.rows;
    }
    const scores = new Map<string, { row: Row; score: number }>();
    for (const list of [lexical.rows, semantic])
      list.forEach((row, i) => {
        const previous = scores.get(row.id);
        scores.set(row.id, { row, score: (previous?.score ?? 0) + 1 / (60 + i + 1) });
      });
    // Do not fill empty recall with unrelated recent facts. The caller can explicitly list its memory.
    return [...scores.values()]
      .sort(
        (a, b) =>
          Number(b.row.pinned) - Number(a.row.pinned) ||
          b.score - a.score ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, 12)
      .map(({ row }) => itemView(row));
  }

  /** Import legacy sources once. Tombstones keep legacy keys, so forgotten content never returns. */
  async importLegacy(): Promise<void> {
    const { rows: profiles } = await this.pool.query<{ about_me: string }>(
      "select about_me from settings where id=1",
    );
    await this.importOnce("legacy:profile", null, profiles[0]?.about_me ?? "", "note", true);
    const { rows: lessons } = await this.pool.query<{
      id: string;
      bot_id: string;
      text: string;
      run_id: string | null;
    }>(
      "select l.id,l.bot_id,l.text,l.run_id from lessons l join bots b on b.id=l.bot_id where b.archived_at is null",
    );
    for (const lesson of lessons)
      await this.importOnce(
        `legacy:lesson:${lesson.id}`,
        lesson.bot_id,
        lesson.text,
        "lesson",
        true,
        lesson.id,
        lesson.run_id ? { type: "feedback", runId: lesson.run_id } : { type: "import" },
      );
  }

  async importOnce(
    key: string,
    botId: string | null,
    content: string,
    kind: MemoryInput["kind"] = "note",
    pinned = false,
    id?: string,
    source?: MemorySource,
  ): Promise<void> {
    const done = await this.pool.query("select key from memory_imports where key=$1", [key]);
    if (done.rowCount) return;
    // Import into one scope transaction through a dedicated lock, then mark even empty sources.
    await this.transaction(async (client) => {
      await this.lockScope(client, botId);
      const claimed = await client.query(
        "insert into memory_imports(key) values($1) on conflict do nothing returning key",
        [key],
      );
      if (!claimed.rowCount || !content.trim()) return;
      const hash = fingerprint(content);
      const existing = await client.query(
        "select id from memory_items where (legacy_key=$1 or (bot_id is not distinct from $2 and fingerprint=$3))",
        [key, botId, hash],
      );
      if (existing.rowCount) return;
      const { rows } = await client.query<Row>(
        `insert into memory_items(id,bot_id,kind,content,fingerprint,pinned,source,legacy_key)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [id ?? randomUUID(), botId, kind, content, hash, pinned, source ?? { type: "import" }, key],
      );
      await this.revision(client, rows[0]!);
      // Importing a batch must not erase other legacy rows before they are imported.
      await client.query(
        `insert into memory_generations(scope,generation) values($1,1) on conflict(scope) do update set generation=memory_generations.generation+1`,
        [scopeOf(botId)],
      );
    });
  }

  async queueExtraction(runId: string): Promise<void> {
    await this.pool.query(
      `insert into memory_jobs(kind,run_id,dedupe_key) values('extract',$1,$2) on conflict(dedupe_key) do nothing`,
      [runId, `extract:${runId}`],
    );
  }
}
