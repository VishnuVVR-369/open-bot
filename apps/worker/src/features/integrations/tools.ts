import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import type { v2 } from "@open-bot/agent";
import { accounts, connections } from "@open-bot/db";
import {
  ACCOUNT_TOOLS,
  accountTool,
  capabilityGranted,
  integration,
  isAccountConnectionKind,
  type AccountConnectionKind,
  type ToolItem,
} from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../../context";
import { errorMessage } from "../../logger";
import type { RunSession } from "../../runs/session";
import type { ConnectionTest } from "@open-bot/api/worker";
import {
  AccountToolError,
  ProviderError,
  type Integrations,
  type ToolContext,
  type ToolResult,
} from "@open-bot/integrations/adapters";
import type { AccountAccess } from "./access";
import type { AccountActions } from "./actions";

type Response = v2.DynamicToolCallResponse;

function text(message: string, success = true): Response {
  return { success, contentItems: [{ type: "inputText", text: message }] };
}

const UNSUCCESSFUL = new Set(["failed", "unknown", "denied", "cancelled", "expired"]);

/**
 * Every integration's tools. Each call is checked against the teammate's access now, not when its
 * thread started; reads come back marked as outside data, and mark the run; changes go through the
 * action executor. The integration's adapter only reads and prepares.
 */
export class AccountTools {
  constructor(
    private readonly ctx: Context,
    private readonly access: AccountAccess,
    private readonly actions: AccountActions,
    private readonly integrations: Integrations,
  ) {}

  /**
   * The connection a teammate means by `account` (or its only one of the kind), for tools that
   * set things up on it, like a Gmail trigger. Throws AccountToolError, said for the teammate.
   */
  async connectionFor(
    botId: string,
    kind: AccountConnectionKind,
    account?: string,
  ): Promise<{ connectionId: string; display: string }> {
    const resolved = await this.access.resolve(botId, kind, account);
    if (resolved.account.status !== "connected")
      throw new AccountToolError(
        `${integration(kind).label} needs reconnecting. Ask the user to reconnect it in Settings → Connections.`,
      );
    this.access.requireCapability(resolved, "read");
    return { connectionId: resolved.connection.id, display: resolved.account.display };
  }

  /** Settings' Test for an account connection: one real call, and the tools teammates get. */
  async test(connectionId: string): Promise<ConnectionTest> {
    const [row] = await this.ctx.db
      .select({ connection: connections, account: accounts })
      .from(connections)
      .innerJoin(accounts, eq(accounts.id, connections.accountId))
      .where(eq(connections.id, connectionId));
    if (!row || !isAccountConnectionKind(row.connection.kind))
      return { ok: false, status: null, tools: [], error: "That connection is gone." };
    const kind = row.connection.kind;
    const label = integration(kind).label;
    const adapter = this.integrations.get(kind);
    if (row.account.status !== "connected")
      return {
        ok: false,
        status: row.account.status,
        tools: [],
        error: `${label} needs reconnecting: ${row.account.lastError ?? "its sign-in stopped working"}.`,
      };
    const resolved = { kind, connection: row.connection, account: row.account };
    const tokens = this.access.tokens(resolved);
    try {
      const status = await adapter.probe(resolved, tokens);
      const tools = ACCOUNT_TOOLS.filter(
        (tool) =>
          tool.kind === kind &&
          row.connection.capabilities.includes(tool.capability) &&
          capabilityGranted(kind, tool.capability, row.account.scopes),
      ).map((tool) => ({ name: tool.name, description: tool.label }));
      return { ok: true, status, tools, error: null };
    } catch (error) {
      const message =
        error instanceof ProviderError
          ? adapter.problem(error)
          : error instanceof AccountToolError
            ? error.ownerMessage
            : errorMessage(error);
      return { ok: false, status: null, tools: [], error: message };
    }
  }

  /** Save a file on the computer, through Codex, which runs there. */
  private async saveFile(path: string, data: Buffer): Promise<void> {
    const client = await this.ctx.codex.ready();
    await client.request("fs/createDirectory", { path: dirname(path), recursive: true });
    await client.request("fs/writeFile", { path, dataBase64: data.toString("base64") });
  }

  async handle(session: RunSession, params: v2.DynamicToolCallParams): Promise<Response> {
    const name = `${params.namespace ?? ""}.${params.tool}`;
    const info = accountTool(name);
    if (!info) return text(`Unknown tool ${name}.`, false);
    const adapter = this.integrations.get(info.kind);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const startedAt = session.now();
    const item: ToolItem = {
      id: params.callId,
      kind: "tool",
      name,
      label: info.label,
      args,
      status: "running",
      startedAt,
    };
    const fail = (message: string) => {
      session.putItem({ ...item, status: "failed", completedAt: session.now(), error: message });
      return text(message, false);
    };
    try {
      // Helpers do their part with what they can read; changes are for the teammate that asked.
      if (session.isHelper && info.capability !== "read")
        return fail(
          "Helpers can only read the user's accounts. Say in your result what should change.",
        );
      const resolved = await this.access.resolve(
        session.bot.id,
        info.kind,
        typeof args.account === "string" ? args.account : undefined,
      );
      if (resolved.account.status !== "connected")
        throw new AccountToolError(
          `${integration(info.kind).label} needs reconnecting. Ask the user to reconnect it in Settings → Connections.`,
        );
      this.access.requireCapability(resolved, info.capability);
      session.putItem(item);
      const tc: ToolContext = {
        resolved,
        tokens: this.access.tokens(resolved),
        args,
        actionId: randomUUID(),
        workspace: session.workspace,
        saveFile: (path, data) => this.saveFile(path, data),
      };
      const result: ToolResult = await adapter.call(params.tool, tc);
      if (result.type === "read") {
        // From here on, everything this run sends out asks the user first.
        if (result.outside) await session.markReadOutsideData();
        session.putItem({
          ...item,
          label: result.label,
          status: "completed",
          completedAt: session.now(),
          ...(result.summary ? { result: result.summary } : {}),
        });
        return text(result.text);
      }
      const outcome = await this.actions.submit(
        session,
        resolved,
        tc.actionId,
        result.action,
        params.callId,
      );
      return text(outcome.message, !UNSUCCESSFUL.has(outcome.status));
    } catch (error) {
      if (error instanceof AccountToolError) return fail(error.message);
      if (error instanceof ProviderError) return fail(adapter.problem(error));
      if (error instanceof z.ZodError)
        return fail(
          error.issues
            .map(
              (issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
            )
            .join("; "),
        );
      this.ctx.log.error("account tool failed", { tool: name, error: errorMessage(error) });
      return fail(`The tool failed: ${errorMessage(error)}`);
    }
  }
}
