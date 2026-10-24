import { createHash, randomBytes } from "node:crypto";
import type { v2 } from "@open-bot/agent";
import { connections } from "@open-bot/db";
import { mcpServersConfig, type ConnectionConfig } from "@open-bot/shared";
import { decryptSecret } from "@open-bot/shared/secrets";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Context } from "../context";
import { errorMessage } from "../logger";

type Row = typeof connections.$inferSelect;
export type CodexConfig = NonNullable<v2.ThreadStartParams["config"]>;

/** Codex's config for these servers. */
function codexConfig(rows: ConnectionConfig[]): CodexConfig {
  return { mcp_servers: mcpServersConfig(rows) } as unknown as CodexConfig;
}

export interface ConnectionTest {
  ok: boolean;
  status: string | null;
  tools: { name: string; description: string }[];
  error: string | null;
}

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
  constructor(private readonly ctx: Context) {}

  private config(row: Row): ConnectionConfig {
    const secrets = row.encrypted
      ? (JSON.parse(decryptSecret(row.encrypted, this.ctx.env.ENCRYPTION_KEY)) as {
          headers?: Record<string, string>;
          env?: Record<string, string>;
        })
      : {};
    return {
      name: row.name,
      transport: row.transport,
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
