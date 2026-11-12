import { createHash, randomBytes } from "node:crypto";
import type { AccountStore } from "@open-bot/integrations/server";
import type { ConnectionInput } from "@open-bot/api";
import type { ConnectionTest } from "@open-bot/api/worker";
import type { v2 } from "@open-bot/agent";
import {
  accounts,
  connections,
  LOCKS,
  lockUntilCommit,
  type Queryable,
  type Tx,
} from "@open-bot/db";
import {
  capabilityGranted,
  connectionName,
  integration,
  integrationSettings,
  invalidMcpUrl,
  mcpServersConfig,
  normalizeCapabilities,
  parseEnvLines,
  parseHeaderLines,
  type AccountCapability,
  type AccountConnectionKind,
  type ConnectionConfig,
  type ConnectionSettings,
} from "@open-bot/domain";
import { decryptSecret, encryptSecret } from "@open-bot/domain/server";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { cancelConnectionActions, cancelEarlierGrantActions } from "../accounts/actions";
import { publishApp, type Context } from "../context";
import { errorMessage } from "../logger";

/** A connection change that can't be made as asked; the message says why. */
export class ConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const GONE = "That connection is gone.";

/**
 * A name no connection has yet, `base` or else `base_2`, `base_3`, ..., held for this transaction:
 * a lock keeps two connections saved at once from picking the same one (names are unique).
 */
async function claimConnectionName(tx: Tx, base: string): Promise<string> {
  await lockUntilCommit(tx, LOCKS.connectionNames);
  const taken = new Set(
    (await tx.select({ name: connections.name }).from(connections)).map((row) => row.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

/** Give a connection these teammates (null is everyone), in the caller's transaction. */
export async function setConnectionTeammates(
  db: Queryable,
  connectionId: string,
  botIds: string[] | null,
): Promise<void> {
  await db.update(connections).set({ botIds }).where(eq(connections.id, connectionId));
}

/** "a b 'c d'" as arguments, keeping quoted ones together. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/** Two teammate or capability lists hold the same entries (null is "everyone"). */
function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return a === null || b === null ? a === b : [...a].sort().join() === [...b].sort().join();
}

/**
 * A connection's settings with what you typed applied, each parsed by its integration. Keys the
 * integration doesn't offer are refused, so nothing else gets stored on the connection.
 */
function parseSettings(
  kind: AccountConnectionKind,
  current: ConnectionSettings,
  typed: Record<string, string>,
): ConnectionSettings {
  const offered = integrationSettings(kind);
  const next: ConnectionSettings = { ...current };
  for (const [key, text] of Object.entries(typed)) {
    const setting = offered.find((entry) => entry.key === key);
    if (!setting)
      throw new ConnectionError(400, `${integration(kind).label} has no setting ${key}.`);
    if (!text.trim()) {
      delete next[key];
      continue;
    }
    const value = setting.parse(text);
    if (!value) throw new ConnectionError(400, setting.invalid);
    next[key] = value;
  }
  return next;
}

type Row = typeof connections.$inferSelect;
export type CodexConfig = NonNullable<v2.ThreadStartParams["config"]>;

/** Codex's config for these servers. */
function codexConfig(rows: ConnectionConfig[]): CodexConfig {
  return { mcp_servers: mcpServersConfig(rows) } as unknown as CodexConfig;
}

export type { ConnectionTest };

/** What went wrong connecting, in words, instead of the MCP client's transport errors. */
function readable(error: string, row: Row): string {
  if (/error sending request|connection refused|dns error|timed out|unreachable/i.test(error))
    return row.transport === "http"
      ? `Couldn't reach ${row.url} from the computer. Check the address, and that the service is up.`
      : `${row.command} didn't answer in time.`;
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(error))
    return "It turned the sign-in down. Check the token in the headers.";
  if (/no such file|not found|ENOENT/i.test(error) && row.transport === "stdio")
    return `The computer couldn't run ${row.command}.`;
  const short = error.replace(/\s+/g, " ").trim();
  return short.length > 300 ? `${short.slice(0, 299)}…` : short;
}

/**
 * Connections give teammates MCP servers, so they use services like GitHub or Notion through
 * their APIs instead of their websites. Each thread gets the ones its teammate may use.
 */
export class ConnectionService {
  constructor(
    private readonly ctx: Context,
    /** Account connections (Gmail, Calendar, Notion) are tested by the worker, not Codex. */
    private readonly accounts?: { test(connectionId: string): Promise<ConnectionTest> },
    /** Accounts' tokens, revoked when the last connection using one goes. */
    private readonly store?: Pick<AccountStore, "revoke">,
    /** Reports cancelled account actions to the runs waiting on them. */
    private readonly actions?: { kick(): void },
  ) {}

  /** Save an MCP server: a new one, or with `id`, a change to one. Its secrets are encrypted. */
  async saveMcp(input: ConnectionInput): Promise<{ id: string }> {
    if (input.transport === "http") {
      const problem = invalidMcpUrl(input.url);
      if (problem) throw new ConnectionError(400, problem);
    } else if (!input.command)
      throw new ConnectionError(400, "Give the command the computer runs.");
    const parsed = input.secrets.trim()
      ? input.transport === "http"
        ? parseHeaderLines(input.secrets)
        : parseEnvLines(input.secrets)
      : null;
    if (typeof parsed === "string") throw new ConnectionError(400, parsed);

    const saved = await this.ctx.db.transaction(async (tx) => {
      const [existing] = input.id
        ? await tx.select().from(connections).where(eq(connections.id, input.id)).for("update")
        : [];
      if (input.id && !existing) throw new ConnectionError(404, GONE);
      if (existing && existing.kind !== "mcp")
        throw new ConnectionError(400, "That's an account, not an MCP server.");
      const name = existing?.name ?? (await claimConnectionName(tx, connectionName(input.label)));
      // Without new secrets, an edit keeps the saved ones, unless the kind of connection changed.
      const keep = !parsed && existing && existing.transport === input.transport;
      const secrets = parsed
        ? input.transport === "http"
          ? { headers: parsed }
          : { env: parsed }
        : null;
      const values = {
        label: input.label,
        name,
        transport: input.transport,
        url: input.transport === "http" ? input.url : null,
        command: input.transport === "stdio" ? input.command : null,
        args: input.transport === "stdio" ? splitArgs(input.args) : [],
        botIds: input.teammateIds,
        ...(keep
          ? {}
          : {
              encrypted: secrets
                ? encryptSecret(JSON.stringify(secrets), this.ctx.env.ENCRYPTION_KEY)
                : null,
              secretNames: parsed ? Object.keys(parsed) : [],
            }),
      };
      const [row] = existing
        ? await tx
            .update(connections)
            .set(values)
            .where(eq(connections.id, existing.id))
            .returning({ id: connections.id })
        : await tx.insert(connections).values(values).returning({ id: connections.id });
      return row!;
    });
    await publishApp(this.ctx, { type: "connections" });
    return saved;
  }

  /**
   * Turn a connection on or off. An account connection's revision moves on either way, and
   * turning it off cancels what waits on it.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const kind = await this.kind(id);
    if (!kind) throw new ConnectionError(404, GONE);
    if (kind === "mcp")
      await this.ctx.db.update(connections).set({ enabled }).where(eq(connections.id, id));
    else {
      await this.ctx.db.transaction(async (tx) => {
        await tx
          .update(connections)
          .set({ enabled, revision: sql`${connections.revision} + 1` })
          .where(eq(connections.id, id));
        if (!enabled) await cancelConnectionActions(tx, id, "You turned this connection off.");
      });
      if (!enabled) await this.reportCancelled();
    }
    await publishApp(this.ctx, { type: "connections" });
  }

  /**
   * Remove a connection. An account's tokens stay while another connection uses the account (one
   * Google sign-in serves Gmail and Calendar); the last one out revokes the grant at the provider,
   * and `warning` says when that couldn't be done.
   */
  async remove(id: string): Promise<{ warning: string | null }> {
    const [row] = await this.ctx.db.select().from(connections).where(eq(connections.id, id));
    if (!row) return { warning: null };
    if (row.kind === "mcp") {
      await this.ctx.db.delete(connections).where(eq(connections.id, row.id));
      await publishApp(this.ctx, { type: "connections" });
      return { warning: null };
    }
    await this.ctx.db.transaction(async (tx) => {
      await cancelConnectionActions(tx, row.id, "You removed this connection.");
      await tx.delete(connections).where(eq(connections.id, row.id));
    });
    await this.reportCancelled();
    let warning: string | null = null;
    if (row.accountId) {
      const [stillUsed] = await this.ctx.db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.accountId, row.accountId))
        .limit(1);
      if (!stillUsed && this.store) warning = (await this.store.revoke(row.accountId)).warning;
    }
    await publishApp(this.ctx, { type: "connections" });
    return { warning };
  }

  /**
   * Change what an account connection allows, who may use it, or how it asks. Returns whether the
   * account must grant more scopes first (then nothing changed; start a sign-in for them).
   *
   * Only a change to what it allows or who uses it counts as a new setup: that bumps its revision,
   * and actions waiting on the old one are cancelled. Changing how it asks, or its settings (like
   * Notion's teammates' area), keeps them.
   */
  async updateAccount(input: {
    connectionId: string;
    capabilities: string[];
    teammateIds: string[] | null;
    askBeforeActing: boolean;
    /** What you typed for the integration's settings, by key: "" clears one, a missing key keeps it. */
    settings?: Record<string, string>;
  }): Promise<{ needsConsent: boolean }> {
    const [row] = await this.ctx.db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId));
    if (!row || row.kind === "mcp" || !row.accountId) throw new ConnectionError(404, GONE);
    const kind = row.kind;
    // Each kind keeps only its own (`normalizeCapabilities`), so unknown names drop out here.
    const capabilities = normalizeCapabilities(kind, input.capabilities as AccountCapability[]);
    const settings = input.settings ? parseSettings(kind, row.settings, input.settings) : null;
    const [account] = await this.ctx.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, row.accountId));
    if (!account) throw new ConnectionError(404, "Its account is gone.");
    if (capabilities.some((capability) => !capabilityGranted(kind, capability, account.scopes)))
      return { needsConsent: true };
    const changed =
      !sameList(row.capabilities, capabilities) || !sameList(row.botIds, input.teammateIds);
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .update(connections)
        .set({
          capabilities,
          botIds: input.teammateIds,
          askBeforeActing: input.askBeforeActing,
          ...(settings ? { settings } : {}),
          ...(changed ? { revision: sql`${connections.revision} + 1` } : {}),
        })
        .where(eq(connections.id, row.id));
      if (changed)
        await cancelConnectionActions(
          tx,
          row.id,
          "You changed this connection after it was asked for.",
        );
    });
    if (changed) await this.reportCancelled();
    await publishApp(this.ctx, { type: "connections" });
    return { needsConsent: false };
  }

  /**
   * You signed in to an account for a connection of `kind`: the account's connection of that kind,
   * created or given the capabilities and teammates you picked. What waits on an earlier grant
   * (one that lost something approvals may rely on, see `saveGrant`) is cancelled first. That is
   * read from the saved grant, so a sign-in retried after this call failed still cancels it.
   */
  async linkAccount(input: {
    accountId: string;
    kind: AccountConnectionKind;
    capabilities: string[];
    teammateIds: string[] | null;
  }): Promise<{ connectionId: string }> {
    const [account] = await this.ctx.db
      .select({ id: accounts.id, display: accounts.display, grantRevision: accounts.grantRevision })
      .from(accounts)
      .where(eq(accounts.id, input.accountId));
    if (!account) throw new ConnectionError(404, "That account is gone.");
    // Each kind keeps only its own (`normalizeCapabilities`), so unknown names drop out here.
    const capabilities = normalizeCapabilities(
      input.kind,
      input.capabilities as AccountCapability[],
    );
    const cancelled = await cancelEarlierGrantActions(
      this.ctx.db,
      account.id,
      account.grantRevision,
      "You signed in again with different access since it was asked for.",
    );
    if (cancelled) await this.reportCancelled();
    const connectionId = await this.upsertAccountConnection(
      account,
      input.kind,
      capabilities,
      input.teammateIds,
    );
    await publishApp(this.ctx, { type: "connections" });
    return { connectionId };
  }

  /** The account's connection of this kind: created, or given the capabilities you picked. */
  private async upsertAccountConnection(
    account: { id: string; display: string },
    kind: AccountConnectionKind,
    capabilities: AccountCapability[],
    botIds: string[] | null,
  ): Promise<string> {
    const definition = integration(kind);
    const [existing] = await this.ctx.db
      .select()
      .from(connections)
      .where(and(eq(connections.accountId, account.id), eq(connections.kind, kind)));
    if (existing) {
      // Signing in again changes nothing teammates asked for, unless what's allowed changed.
      if (sameList(existing.capabilities, capabilities) && sameList(existing.botIds, botIds))
        return existing.id;
      await this.ctx.db.transaction(async (tx) => {
        await tx
          .update(connections)
          .set({ capabilities, botIds, revision: sql`${connections.revision} + 1` })
          .where(eq(connections.id, existing.id));
        await cancelConnectionActions(
          tx,
          existing.id,
          "You changed this connection after it was asked for.",
        );
      });
      await this.reportCancelled();
      return existing.id;
    }
    return this.ctx.db.transaction(async (tx) => {
      const name = await claimConnectionName(tx, connectionName(definition.label));
      const others = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.kind, kind));
      const [row] = await tx
        .insert(connections)
        .values({
          kind,
          label: others.length ? `${definition.label} (${account.display})` : definition.label,
          name,
          accountId: account.id,
          capabilities,
          botIds,
        })
        .returning({ id: connections.id });
      return row!.id;
    });
  }

  private async kind(id: string) {
    const [row] = await this.ctx.db
      .select({ kind: connections.kind })
      .from(connections)
      .where(eq(connections.id, id));
    return row?.kind ?? null;
  }

  /** Tell the runs whose account actions were just cancelled, and refresh approvals. */
  private async reportCancelled(): Promise<void> {
    this.actions?.kick();
    await publishApp(this.ctx, { type: "approvals" });
  }

  private config(row: Row): ConnectionConfig {
    const secrets = row.encrypted
      ? (JSON.parse(decryptSecret(row.encrypted, this.ctx.env.ENCRYPTION_KEY)) as {
          headers?: Record<string, string>;
          env?: Record<string, string>;
        })
      : {};
    return {
      name: row.name,
      transport: row.transport ?? "http",
      url: row.url,
      command: row.command,
      args: row.args,
      headers: secrets.headers ?? {},
      env: secrets.env ?? {},
    };
  }

  /** The connections a teammate may use, as Codex config, and a key that changes with them. */
  async forBot(botId: string): Promise<{ key: string; config: CodexConfig; labels: string[] }> {
    const rows = await this.ctx.db
      .select()
      .from(connections)
      .where(
        and(
          // Accounts (Gmail, Calendar, Notion) aren't MCP servers on the computer: the worker
          // serves their tools, so their tokens never reach it.
          eq(connections.kind, "mcp"),
          eq(connections.enabled, true),
          or(isNull(connections.botIds), sql`${botId} = any(${connections.botIds})`),
        ),
      )
      .orderBy(asc(connections.name));
    if (rows.length === 0) return { key: "", config: {}, labels: [] };
    const key = createHash("sha256")
      .update(rows.map((row) => `${row.id}:${row.updatedAt.toISOString()}`).join(","))
      .digest("hex")
      .slice(0, 16);
    return {
      key,
      config: codexConfig(rows.map((row) => this.config(row))),
      labels: rows.map((row) => row.label),
    };
  }

  /** Connect to one server on a throwaway thread, and list what it offers. */
  async test(id: string): Promise<ConnectionTest> {
    const [row] = await this.ctx.db.select().from(connections).where(eq(connections.id, id));
    if (!row) return { ok: false, status: null, tools: [], error: "That connection is gone." };
    if (row.kind !== "mcp") {
      if (!this.accounts)
        return { ok: false, status: null, tools: [], error: "Accounts aren't available." };
      return this.accounts.test(row.id);
    }
    const client = await this.ctx.codex.ready();
    // A name of its own, so Codex connects for real instead of answering from its tools cache.
    const probe = {
      ...this.config(row),
      name: `${row.name}_test_${randomBytes(4).toString("hex")}`,
    };
    try {
      const thread = await client.request("thread/start", {
        cwd: "/home/bot",
        ephemeral: true,
        serviceName: "open-bot",
        config: codexConfig([probe]),
      } as v2.ThreadStartParams);
      const response = await client.request("mcpServerStatus/list", {
        threadId: thread.thread.id,
        serverName: probe.name,
      });
      const status = response.data.find((entry) => entry.name === probe.name);
      if (!status) return { ok: false, status: null, tools: [], error: "It didn't start." };
      const tools = Object.values(status.tools)
        .filter((tool) => tool !== undefined)
        .map((tool) => ({ name: tool.name, description: tool.description ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const connected =
        status.runtimeStatus === "connected" || (tools.length > 0 && !status.toolsError);
      return {
        ok: connected,
        status: status.runtimeStatus,
        tools,
        error: connected
          ? null
          : status.runtimeStatus === "authenticationRequired"
            ? "It needs you to sign in. Add the token it expects as a header."
            : readable(
                status.toolsError ?? `It's ${status.runtimeStatus ?? "not connected"}.`,
                row,
              ),
      };
    } catch (error) {
      return { ok: false, status: null, tools: [], error: readable(errorMessage(error), row) };
    }
  }
}
