// The MCP client to Notion's hosted server: one session per account, opened again when it
// expires and closed when idle.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccountToolError } from "../../core/errors";
import { ProviderError, type TokenSource } from "../../core/http";
import type { IntegrationHost } from "../../core/adapter";
import { type McpResult } from "./results";

const CALL_TIMEOUT_MS = 90_000;
/** An idle connection to Notion is closed after this long. */
const IDLE_MS = 5 * 60_000;

/** A client per account, kept open for a while: a Notion session takes a handshake to start. */
export interface OpenClient {
  client: Client;
  lastUsed: number;
}

/** The worker's sessions with Notion's MCP server, by account. */
export class NotionMcp {
  private readonly clients = new Map<string, Promise<OpenClient>>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor(private readonly host: IntegrationHost) {
    this.idleTimer = setInterval(() => this.closeIdle(), 60_000).unref();
  }

  /** Stops the idle sweep and closes every open Notion session. */
  async stop(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.clients.keys()].map((accountId) => this.drop(accountId)));
  }

  connect(accountId: string, tokens: TokenSource): Promise<OpenClient> {
    const existing = this.clients.get(accountId);
    if (existing) return existing;
    const opening = (async () => {
      const authorized = async (url: string | URL, init?: RequestInit) => {
        const send = async (token: string) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${token}`);
          return fetch(url, { ...init, headers });
        };
        const response = await send(await tokens.token());
        if (response.status !== 401) return response;
        await response.body?.cancel().catch(() => {});
        return send(await tokens.refresh());
      };
      const transport = new StreamableHTTPClientTransport(
        new URL(this.host.endpoints.notionMcpUrl),
        {
          fetch: authorized,
        },
      );
      const client = new Client({ name: "open-bot", version: "1.0.0" });
      await client.connect(transport);
      return { client, lastUsed: Date.now() };
    })();
    this.clients.set(accountId, opening);
    opening.catch(() => this.clients.delete(accountId));
    return opening;
  }

  private async drop(accountId: string): Promise<void> {
    const open = this.clients.get(accountId);
    this.clients.delete(accountId);
    await open?.then((entry) => entry.client.close()).catch(() => {});
  }

  private closeIdle(): void {
    for (const [accountId, open] of this.clients) {
      void open
        .then((entry) => {
          if (Date.now() - entry.lastUsed > IDLE_MS) void this.drop(accountId);
        })
        .catch(() => {});
    }
  }

  /**
   * Call one of Notion's tools. An expired session is opened again once; anything else that fails
   * after a write was sent may have happened, and says so.
   */
  async callTool(
    accountId: string,
    tokens: TokenSource,
    name: string,
    args: Record<string, unknown>,
    mode: "read" | "write",
  ): Promise<McpResult> {
    for (let attempt = 0; ; attempt += 1) {
      let open: OpenClient;
      try {
        open = await this.connect(accountId, tokens);
      } catch (error) {
        if (error instanceof AccountToolError) throw error;
        // Nothing was sent yet: the session didn't even start.
        throw new ProviderError(`Couldn't reach Notion: ${messageOf(error)}`, null, false);
      }
      open.lastUsed = Date.now();
      try {
        return (await open.client.callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        })) as McpResult;
      } catch (error) {
        await this.drop(accountId);
        if (error instanceof AccountToolError) throw error;
        // Notion forgot the session: nothing ran, so a new one can try again.
        if (error instanceof StreamableHTTPError && error.code === 404 && attempt === 0) continue;
        if (mode === "read" && attempt === 0) continue;
        const status = error instanceof StreamableHTTPError ? (error.code ?? null) : null;
        throw new ProviderError(
          `Notion: ${messageOf(error)}`,
          status,
          mode === "write" && !(status !== null && status >= 400 && status < 500),
        );
      }
    }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
