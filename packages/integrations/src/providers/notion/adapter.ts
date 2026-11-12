import { notionMcpUrl } from "../../core/endpoints";
import { accountResources } from "@open-bot/db";
import {
  NOTION_AREA_SETTING,
  outsideData,
  type AccountActionPreview,
  type ActionEffect,
} from "@open-bot/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AccountToolError } from "../../core/errors";
import { ProviderError, type TokenSource } from "../../core/http";
import { namespace, tool, type NamespaceTool } from "../../core/tool-spec";
import { notionEffect, notionId, notionParent } from "./effects";
import type {
  ActionOutcome,
  ActionRunner,
  IntegrationAdapter,
  PreparedAction,
  ToolContext,
  IntegrationHost,
  ResolvedConnection,
  ToolResult,
} from "../../core/adapter";

/** Our tool names, and Notion's. Only these are ever forwarded. */
export const NOTION_TOOL_NAMES: Record<string, string> = {
  search: "notion-search",
  fetch: "notion-fetch",
  query_database: "notion-query-data-sources",
  get_comments: "notion-get-comments",
  get_users: "notion-get-users",
  create_pages: "notion-create-pages",
  update_page: "notion-update-page",
  move_pages: "notion-move-pages",
  duplicate_page: "notion-duplicate-page",
  create_database: "notion-create-database",
  update_database: "notion-update-data-source",
  add_comment: "notion-create-comment",
};

const READS = new Set(["search", "fetch", "query_database", "get_comments", "get_users"]);
const ASYNC_TASK_TOOL = "notion-get-async-task";
const CALL_TIMEOUT_MS = 90_000;
/** An idle connection to Notion is closed after this long. */
const IDLE_MS = 5 * 60_000;
const MAX_RESULT_TEXT = 100_000;
/** What a teammate may fetch: a Notion id, a Notion page link, or a data source or view. */
const FETCHABLE =
  /^(?:https:\/\/(?:[a-z0-9-]+\.)?notion\.(?:so|site)\/|collection:\/\/|view:\/\/)/i;
/** Result types that are Notion's own content; anything else (connected sources) is dropped. */
const NOTION_TYPES = new Set([
  "page",
  "database",
  "data_source",
  "data-source",
  "user",
  "person",
  "bot", // vocabulary: allow (a Notion result type)
]);

interface McpResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function resultText(result: McpResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text!)
    .join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The result's data: its structured content, or its text as JSON. */
function resultData(result: McpResult): unknown {
  return result.structuredContent ?? parseJson(resultText(result));
}

function cap(text: string): string {
  return text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n[… cut]` : text;
}

/** Ids of what a create made, from its result, so later changes to them count as the teammates'. */
export function createdIds(data: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["id", "page_id", "database_id", "data_source_id"]) {
      const raw = record[key];
      const id = typeof raw === "string" ? notionId(raw) : null;
      if (id) ids.add(id);
    }
    for (const key of ["pages", "result", "database", "data_sources", "data_source"])
      visit(record[key], depth + 1);
  };
  visit(data, 0);
  // Data sources also show up as collection:// links.
  for (const match of JSON.stringify(data ?? "").matchAll(/collection:\/\/([0-9a-f-]{32,36})/gi)) {
    const id = notionId(match[1]!);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Notion's answer that a write continues in the background. */
function asyncTask(data: unknown): { id: string; pollAfterMs: number } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const task =
    record.object === "async_task"
      ? record
      : (record.async_task as Record<string, unknown> | undefined);
  if (!task || typeof task.id !== "string") return null;
  const seconds = typeof task.poll_after_seconds === "number" ? task.poll_after_seconds : 2;
  return { id: task.id, pollAfterMs: Math.min(Math.max(seconds, 1), 30) * 1000 };
}

const accountArg = z.string().optional();
/** Notion's own arguments pass through; these are the ones open-bot checks. */
const passthrough = z.object({ account: accountArg }).passthrough();
const pageRef = z.string().trim().min(1);

const schemas = {
  search: passthrough.extend({ query: z.string().max(1000) }),
  fetch: passthrough.extend({ id: pageRef }),
  create_pages: passthrough.extend({
    pages: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  }),
  update_page: passthrough.extend({ page_id: pageRef, command: z.string().min(1) }),
  // Always asks, so nothing here decides anything: Notion checks the rest.
  move_pages: passthrough,
  duplicate_page: passthrough.extend({ page_id: pageRef }),
  create_database: passthrough,
  update_database: passthrough.extend({ data_source_id: pageRef }),
  add_comment: passthrough,
};

/** A link to a Notion page from its id. */
function pageUrl(id: string): string {
  return `https://www.notion.so/${id}`;
}

function titleOf(page: Record<string, unknown>): string {
  const properties = page.properties as Record<string, unknown> | undefined;
  const title = properties?.title ?? properties?.Title ?? properties?.Name;
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled";
}

function excerpt(value: unknown, max = 600): string {
  const text =
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A client per account, kept open for a while: a Notion session takes a handshake to start. */
interface OpenClient {
  client: Client;
  lastUsed: number;
}

const passes = "Other arguments of Notion's tool of the same name pass through as they are.";

const NOTION_TOOLS: NamespaceTool[] = [
  tool(
    "search",
    `Search the user's Notion workspace (pages, databases, and people with query_type "user"). ${passes}`,
    { query: { type: "string" }, query_type: { type: "string", enum: ["internal", "user"] } },
    ["query"],
    true,
  ),
  tool(
    "fetch",
    `Read a Notion page, database or data source as Markdown, by id or notion.so link (or a collection:// or view:// link from a database). ${passes}`,
    { id: { type: "string" } },
    ["id"],
    true,
  ),
  tool(
    "query_database",
    `Read rows of a Notion data source (Notion's notion-query-data-sources): mode "rows" with data_source_url, "view" with a view:// url, or SQL. ${passes}`,
    {
      mode: { type: "string" },
      data_source_url: { type: "string" },
      filter: { type: "object" },
      sort: { type: "array", items: { type: "object" } },
      limit: { type: "integer" },
    },
    [],
    true,
  ),
  tool(
    "get_comments",
    `Read a page's comments and discussions. ${passes}`,
    { page_id: { type: "string" } },
    ["page_id"],
    true,
  ),
  tool(
    "get_users",
    `List people in the workspace, or look one up. ${passes}`,
    { query: { type: "string" } },
    [],
    true,
  ),
  tool(
    "create_pages",
    `Create pages: pages is a list of { properties: { title: "…" }, content: "Markdown" }. Under the teammates' area (see AGENTS.md), or with no parent (a private page), it just happens; anywhere else others could see, it asks the user first. ${passes}`,
    {
      parent: {
        type: "object",
        description: "{ page_id } or { data_source_id }. Leave out for a private page.",
      },
      pages: { type: "array", items: { type: "object" }, minItems: 1 },
    },
    ["pages"],
    true,
  ),
  tool(
    "update_page",
    `Change a page's content or properties (command: "update_properties", "update_content" with search-and-replace, "replace_content", …). Pages you made, or in the teammates' area, change directly; others ask the user first. Fetch the page first. ${passes}`,
    { page_id: { type: "string" }, command: { type: "string" } },
    ["page_id", "command"],
    true,
  ),
  tool(
    "move_pages",
    `Move pages or databases to a new parent. People can gain or lose access, so it always asks the user first. ${passes}`,
    {
      page_or_database_ids: { type: "array", items: { type: "string" }, minItems: 1 },
      new_parent: { type: "object" },
    },
    ["page_or_database_ids", "new_parent"],
    true,
  ),
  tool(
    "duplicate_page",
    `Duplicate a page. It asks the user first. ${passes}`,
    { page_id: { type: "string" } },
    ["page_id"],
    true,
  ),
  tool(
    "create_database",
    `Create a database. Under the teammates' area it just happens; elsewhere it asks the user first. ${passes}`,
    { parent: { type: "object" } },
    [],
    true,
  ),
  tool(
    "update_database",
    `Change a data source's properties or name. Ones you made change directly; others ask the user first. ${passes}`,
    { data_source_id: { type: "string" } },
    ["data_source_id"],
    true,
  ),
  tool(
    "add_comment",
    `Comment on a page or reply in a discussion, as the user. People get notified, so it asks the user first. ${passes}`,
    { page_id: { type: "string" }, discussion_id: { type: "string" } },
    [],
    true,
  ),
];

/**
 * Notion for teammates, through Notion's hosted MCP server. The worker is the MCP client and holds
 * the token; teammates get a curated set of Notion's tools, checked and classified here.
 */
export class NotionTools implements IntegrationAdapter {
  static readonly spec = namespace(
    "notion",
    "The user's Notion workspace: search and read pages and databases, and write pages. Writes others can see ask the user first.",
    NOTION_TOOLS,
  );
  readonly kind = "notion" as const;
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

  private connect(accountId: string, tokens: TokenSource): Promise<OpenClient> {
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
      const transport = new StreamableHTTPClientTransport(new URL(notionMcpUrl()), {
        fetch: authorized,
      });
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

  /**
   * Proves the connection works, for Settings' Test: Notion's tools are listed, and every one
   * open-bot forwards has to be among them.
   */
  async probe(resolved: ResolvedConnection, tokens: TokenSource): Promise<string> {
    let open: OpenClient;
    try {
      open = await this.connect(resolved.account.id, tokens);
    } catch (error) {
      if (error instanceof AccountToolError) throw error;
      throw new ProviderError(`Couldn't reach Notion: ${messageOf(error)}`, null, false);
    }
    const { tools } = await open.client.listTools();
    const names = new Set(tools.map((entry) => entry.name));
    const missing = Object.values(NOTION_TOOL_NAMES).filter((name) => !names.has(name));
    if (missing.length)
      throw new ProviderError(
        `Notion no longer offers ${missing.join(", ")}. open-bot needs an update.`,
        null,
        false,
      );
    return `Connected to ${resolved.account.display}`;
  }

  problem(error: ProviderError): string {
    return error.message;
  }

  async call(tool: string, tc: ToolContext): Promise<ToolResult> {
    const notionTool = NOTION_TOOL_NAMES[tool];
    if (!notionTool) throw new AccountToolError(`Notion has no tool ${tool}.`);
    if (READS.has(tool)) return this.read(tool, notionTool, tc);
    return { type: "action", action: await this.prepare(tool, notionTool, tc) };
  }

  private async read(tool: string, notionTool: string, tc: ToolContext): Promise<ToolResult> {
    const { account: _account, ...args } = (
      schemas[tool as keyof typeof schemas] ?? passthrough
    ).parse(tc.args);
    if (tool === "fetch") {
      const id = String(args.id);
      if (!FETCHABLE.test(id) && notionId(id) !== id.replace(/-/g, "").toLowerCase())
        throw new AccountToolError(
          "Fetch takes a Notion page, database or data source id, or a notion.so link.",
        );
    }
    const result = await this.callTool(tc.resolved.account.id, tc.tokens, notionTool, args, "read");
    const text = resultText(result);
    if (result.isError)
      throw new AccountToolError(`Notion: ${excerpt(text, 1000) || "it refused the request."}`);
    let data = resultData(result);
    let body = text;
    if (tool === "fetch") {
      const metadata = (data as { metadata?: { type?: string } } | null)?.metadata;
      if (metadata?.type === "connector")
        throw new AccountToolError(
          "That comes from a source connected to Notion, which teammates can't read through Notion.",
        );
    }
    if (
      tool === "search" &&
      data &&
      typeof data === "object" &&
      Array.isArray((data as { results?: unknown }).results)
    ) {
      // Only Notion's own pages and databases: results from connected apps are left out.
      const results = (data as { results: Record<string, unknown>[] }).results.filter(
        (entry) => typeof entry.type !== "string" || NOTION_TYPES.has(entry.type),
      );
      data = { ...(data as object), results };
      body = JSON.stringify(data, null, 1);
    }
    const count = Array.isArray((data as { results?: unknown[] } | null)?.results)
      ? (data as { results: unknown[] }).results.length
      : null;
    const labels: Record<string, string> = {
      search: `Searched Notion: ${String(args.query ?? "")}`,
      fetch: `Read a Notion ${String(args.id).startsWith("collection://") ? "database" : "page"}`,
      query_database: "Read a Notion database",
      get_comments: "Read Notion comments",
      get_users: "Listed Notion people",
    };
    return {
      type: "read",
      outside: tool !== "get_users",
      label: labels[tool]!.slice(0, 120),
      ...(count !== null ? { summary: `${count} result${count === 1 ? "" : "s"}` } : {}),
      text:
        tool === "get_users"
          ? cap(body)
          : outsideData(
              `From Notion (${tc.resolved.account.display}): ${tool.replace("_", " ")} result`,
              cap(body),
            ),
    };
  }

  /** What teammates made, and their area: changes there count as theirs, not yours. */
  private async ours(
    connection: ResolvedConnection["connection"],
  ): Promise<(id: string) => boolean> {
    const owned = await this.host.db
      .select({ externalId: accountResources.externalId })
      .from(accountResources)
      .where(eq(accountResources.connectionId, connection.id));
    const ids = new Set(owned.map((row) => row.externalId));
    const setting = connection.settings[NOTION_AREA_SETTING];
    const area = setting ? notionId(setting.id) : null;
    if (area) ids.add(area);
    return (id) => ids.has(id);
  }

  private async prepare(
    tool: string,
    notionTool: string,
    tc: ToolContext,
  ): Promise<PreparedAction> {
    const { account: _account, ...args } = (
      schemas[tool as keyof typeof schemas] ?? passthrough
    ).parse(tc.args);
    const isOurs = await this.ours(tc.resolved.connection);
    const effect: ActionEffect = notionEffect(tool, args, isOurs);
    const workspace = tc.resolved.account.display;
    const describe = this.describe(tool, args);
    const preview: AccountActionPreview = {
      type: "change",
      service: "Notion",
      account: workspace,
      action: describe.action,
      target: describe.target,
      detail: describe.detail,
      ...(describe.url ? { url: describe.url } : {}),
      ...(tool === "move_pages" || tool === "duplicate_page" ? { changesAccess: true } : {}),
    };
    return {
      tool: `notion.${tool}`,
      effect,
      request: { notionTool, args },
      summary: `${describe.action} ${describe.target}`.trim(),
      detail: describe.detail,
      preview,
      labels: {
        waiting: `${describe.action} in Notion waits for you`,
        done: describe.done,
        failed: `Couldn't ${describe.action.toLowerCase()} in Notion`,
      },
    };
  }

  /** How a Notion write reads on its approval card and in the timeline. */
  private describe(
    tool: string,
    args: Record<string, unknown>,
  ): { action: string; target: string; detail: string; done: string; url?: string } {
    const parent = notionParent(args.parent);
    const where =
      parent === null
        ? "as a private page"
        : parent === "unknown"
          ? "somewhere Notion decides"
          : parent.kind === "memory"
            ? "in the user's Notion memory"
            : parent.kind === "teamspace"
              ? `at the top of a teamspace (${parent.id})`
              : `under ${parent.id ? pageUrl(parent.id) : "a page"}`;
    switch (tool) {
      case "create_pages": {
        const pages = (args.pages as Record<string, unknown>[]) ?? [];
        const titles = pages.map(titleOf);
        return {
          action: pages.length === 1 ? "Create a page" : `Create ${pages.length} pages`,
          target: where,
          detail: pages
            .map((page) => `“${titleOf(page)}”\n${excerpt(page.content)}`.trim())
            .join("\n\n"),
          done: `Created ${titles.length === 1 ? `“${titles[0]}”` : `${titles.length} pages`} in Notion`,
          ...(parent && parent !== "unknown" && parent.id ? { url: pageUrl(parent.id) } : {}),
        };
      }
      case "update_page": {
        const id = notionId(String(args.page_id)) ?? String(args.page_id);
        const { page_id: _page, command, ...rest } = args;
        return {
          action: "Change a page",
          target: pageUrl(id),
          detail: `${String(command)}\n${excerpt(rest, 1200)}`,
          done: "Changed a Notion page",
          url: pageUrl(id),
        };
      }
      case "move_pages": {
        const raw = Array.isArray(args.page_or_database_ids)
          ? (args.page_or_database_ids as unknown[])
          : [];
        const ids = raw.map((id) => notionId(String(id)) ?? String(id));
        return {
          action: ids.length === 1 ? "Move a page" : `Move ${ids.length} pages`,
          target: `to ${excerpt(args.new_parent, 200)}`,
          detail: `${ids.map(pageUrl).join("\n")}\nMoved pages take the access of their new place, so people can gain or lose access to them.`,
          done: `Moved ${ids.length === 1 ? "a page" : `${ids.length} pages`} in Notion`,
        };
      }
      case "duplicate_page": {
        const id = notionId(String(args.page_id)) ?? String(args.page_id);
        return {
          action: "Duplicate a page",
          target: pageUrl(id),
          detail: "The copy goes next to the original, and anyone who can see there can see it.",
          done: "Duplicated a Notion page",
          url: pageUrl(id),
        };
      }
      case "create_database":
        return {
          action: "Create a database",
          target: where,
          detail: excerpt(args, 1200),
          done: "Created a Notion database",
        };
      case "update_database": {
        const id = notionId(String(args.data_source_id)) ?? String(args.data_source_id);
        return {
          action: "Change a database",
          target: pageUrl(id),
          detail: excerpt(args, 1200),
          done: "Changed a Notion database",
        };
      }
      case "add_comment": {
        const target =
          typeof args.page_id === "string"
            ? args.page_id
            : typeof args.discussion_id === "string"
              ? args.discussion_id
              : "";
        const id = notionId(target);
        return {
          action: "Comment",
          target: id ? `on ${pageUrl(id)}` : "in Notion",
          detail: excerpt(args.rich_text ?? args.markdown ?? args.text ?? args, 1200),
          done: "Commented in Notion",
          ...(id ? { url: pageUrl(id) } : {}),
        };
      }
      default:
        return { action: tool, target: "", detail: excerpt(args), done: `Did ${tool} in Notion` };
    }
  }

  /** Runs Notion actions for the executor. Nothing here is ever retried blindly. */
  readonly runner: ActionRunner = {
    execute: async (action, tokens, resolved) => {
      const request = action.request as { notionTool: string; args: Record<string, unknown> };
      const result = await this.callTool(
        resolved.account.id,
        tokens,
        request.notionTool,
        request.args,
        "write",
      );
      return this.outcome(result);
    },
    // Notion has no way to make a write safe to repeat, so an interrupted one stays unknown.
    reconcile: async () => null,
    poll: async (action, tokens, resolved) => {
      const taskId = String((action.providerRef as { taskId?: unknown } | null)?.taskId ?? "");
      const result = await this.callTool(
        resolved.account.id,
        tokens,
        ASYNC_TASK_TOOL,
        { task_id: taskId },
        "read",
      );
      if (result.isError)
        return { status: "failed", error: `Notion: ${excerpt(resultText(result), 500)}` };
      const data = resultData(result) as {
        status?: string;
        result?: unknown;
        error?: unknown;
        poll_after_seconds?: number;
      } | null;
      if (data?.status === "succeeded")
        return {
          status: "done",
          message: `Done. ${excerpt(data.result, 2000)}`,
          result: { data: data.result as unknown } as Record<string, unknown>,
          providerRef: { taskId },
        };
      if (data?.status === "failed")
        return {
          status: "failed",
          error: `Notion: ${excerpt(data.error, 500) || "the task failed."}`,
        };
      return {
        status: "waiting",
        providerRef: { taskId },
        checkAfterMs: Math.min(Math.max((data?.poll_after_seconds ?? 3) * 1000, 1000), 30_000),
      };
    },
    done: async (action, outcome) => {
      const tool = action.tool.replace(/^notion\./, "");
      if ((tool !== "create_pages" && tool !== "create_database") || !action.connectionId) return;
      const request = action.request as { args: Record<string, unknown> };
      const parent = notionParent(request.args.parent);
      const ids = createdIds(outcome.result?.data ?? outcome.result);
      if (ids.length === 0) return;
      await this.host.db
        .insert(accountResources)
        .values(
          ids.map((externalId) => ({
            connectionId: action.connectionId!,
            externalId,
            kind: tool === "create_pages" ? ("notion_page" as const) : ("notion_database" as const),
            private: parent === null,
            actionId: action.id,
          })),
        )
        .onConflictDoNothing();
    },
  };

  private outcome(result: McpResult): ActionOutcome {
    const text = resultText(result);
    if (result.isError)
      return {
        status: "failed",
        error: `Notion: ${excerpt(text, 1000) || "it refused the request."}`,
      };
    const data = resultData(result);
    const task = asyncTask(data);
    if (task)
      return {
        status: "waiting",
        providerRef: { taskId: task.id },
        checkAfterMs: task.pollAfterMs,
      };
    return {
      status: "done",
      message: `Done. ${excerpt(text, 2000)}`,
      result: { data: (data ?? text) as unknown } as Record<string, unknown>,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
