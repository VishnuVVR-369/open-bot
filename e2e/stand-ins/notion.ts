import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  bearer,
  type Exchange,
  form,
  HOUR,
  id16,
  json,
  jsonBody,
  OUR_TOKEN,
  page,
  redirect,
  s256,
  send,
  token,
} from "./http";
import { GOOGLE_USER } from "./google";

export const NOTION_WORKSPACE = {
  id: "e2e00000-0000-4000-8000-00000000a001",
  name: "E2E Workspace",
  userId: "e2e00000-0000-4000-8000-00000000b001",
  botId: "e2e00000-0000-4000-8000-00000000c001",
};

/** How the app records the Notion account: workspace and user. */
export const NOTION_EXTERNAL_ID = `${NOTION_WORKSPACE.id}:${NOTION_WORKSPACE.userId}`;

/** Seeded Notion pages, by their 32-digit ids. */
export const NOTION_PAGES = {
  area: "1a2b3c4d5e6f40718293a4b5c6d7e8f9",
  roadmap: "2b3c4d5e6f7040818293a4b5c6d7e8fa",
  notes: "3c4d5e6f708140918293a4b5c6d7e8fb",
};

/** The names of every tool the stand-in's Notion MCP offers, as Notion names them. */
export const NOTION_TOOL_NAMES = [
  "notion-search",
  "notion-fetch",
  "notion-query-data-sources",
  "notion-get-comments",
  "notion-get-users",
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
  "notion-duplicate-page",
  "notion-create-database",
  "notion-update-data-source",
  "notion-create-comment",
  "notion-get-async-task",
] as const;

/** Notion's ids as it writes them: a UUID with dashes. */
const dashed = (id: string) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

const notionIdOf = (value: string) => {
  const match =
    /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i.exec(
      value,
    );
  return match ? match.slice(1).join("").toLowerCase() : null;
};

// ---------------------------------------------------------------------------------------------
// Notion: OAuth with dynamic client registration, and its hosted MCP server

export interface NotionPage {
  id: string;
  title: string;
  parentId: string | null;
  content: string;
  kind: "page" | "database";
  /** Made through the MCP (a teammate), not seeded. */
  made: boolean;
}

interface NotionGrant {
  clientId: string;
  refreshToken: string;
  /** Refresh tokens rotated away; using one again ends the grant, as Notion does. */
  rotated: Set<string>;
  revoked: boolean;
}

export interface NotionCall {
  tool: string;
  args: Record<string, unknown>;
  at: number;
}

/** Notion's sign-in and MCP tools, over a small workspace. */
export class NotionStandIn {
  readonly clients = new Map<string, { redirectUris: string[]; name: string }>();
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; used: boolean }
  >();
  readonly grants: NotionGrant[] = [];
  readonly accessTokens = new Map<string, { grant: NotionGrant; expiresAt: number }>();
  readonly pages = new Map<string, NotionPage>();
  readonly comments: { pageId: string; text: string }[] = [];
  /** Every tool call, in order. */
  readonly calls: NotionCall[] = [];
  readonly authorizations: Record<string, string>[] = [];
  readonly tokenRequests: string[] = [];
  readonly revocations: string[] = [];
  /** Writes answer with an async task, which finishes on the second poll. */
  asyncWrites = false;
  deny = false;
  private readonly tasks = new Map<string, { result: unknown; polls: number }>();
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();

  constructor(private readonly origin: string) {
    this.seedPages();
  }

  private seedPages() {
    const seed = (id: string, title: string, content: string) =>
      this.pages.set(id, { id, title, parentId: null, content, kind: "page", made: false });
    seed(NOTION_PAGES.area, "Teammates", "Pages my teammates keep.");
    seed(
      NOTION_PAGES.roadmap,
      "Roadmap",
      "Q1: ship accounts. Q2: mobile app. Shared with the team.",
    );
    seed(NOTION_PAGES.notes, "Private notes", "Gift ideas for Sam.");
  }

  get resource() {
    return `${this.origin}/mcp`;
  }

  /** Children of a page, as this workspace has them now. */
  childrenOf(pageId: string): NotionPage[] {
    return [...this.pages.values()].filter((entry) => entry.parentId === pageId);
  }

  calledTools(): string[] {
    return this.calls.map((call) => call.tool);
  }

  /** Every access token expires, so the next call refreshes (and rotates). */
  expireAccessTokens() {
    for (const access of this.accessTokens.values()) access.expiresAt = 0;
  }

  /** Notion forgets every MCP session, as after its own deploy. */
  dropSessions() {
    for (const transport of this.sessions.values()) void transport.close();
    this.sessions.clear();
  }

  revokeAll() {
    for (const grant of this.grants) grant.revoked = true;
  }

  private live(value: string | null) {
    const access = value ? this.accessTokens.get(value) : undefined;
    return access && !access.grant.revoked && access.expiresAt > Date.now() ? access : null;
  }

  handle(ex: Exchange): Promise<boolean> | boolean {
    const path = ex.url.pathname;
    if (ex.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      json(ex, 200, {
        resource: this.resource,
        authorization_servers: [this.origin],
        bearer_methods_supported: ["header"],
        resource_name: "Notion MCP (E2E stand-in)",
      });
      return true;
    }
    if (ex.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(ex, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/notion/authorize`,
        token_endpoint: `${this.origin}/notion/token`,
        registration_endpoint: `${this.origin}/notion/register`,
        revocation_endpoint: `${this.origin}/notion/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_post",
          "client_secret_basic",
        ],
      });
      return true;
    }
    if (path === "/mcp") return this.mcp(ex).then(() => true);
    const routes: Record<string, (ex: Exchange) => void> = {
      "POST /notion/register": (e) => this.register(e),
      "GET /notion/authorize": (e) => this.authorize(e),
      "POST /notion/token": (e) => this.token(e),
      "POST /notion/revoke": (e) => this.revoke(e),
    };
    const route = routes[`${ex.method} ${path}`];
    route?.(ex);
    return Boolean(route);
  }

  private register(ex: Exchange) {
    const body = jsonBody(ex);
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((uri) => typeof uri === "string" && /^https?:\/\//.test(uri))
    )
      return json(ex, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a list of http(s) URLs.",
      });
    const clientId = `e2e-notion-client-${this.clients.size + 1}-${id16()}`;
    this.clients.set(clientId, { redirectUris: uris as string[], name: String(body.client_name) });
    json(ex, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  private authorize(ex: Exchange) {
    const params = Object.fromEntries(ex.url.searchParams);
    this.authorizations.push(params);
    const client = this.clients.get(params.client_id ?? "");
    if (!client) return page(ex, 400, "Invalid client", "This app isn't registered with Notion.");
    if (!client.redirectUris.includes(params.redirect_uri ?? ""))
      return page(ex, 400, "Invalid redirect", "That redirect URI isn't registered.");
    const back = new URL(params.redirect_uri!);
    if (params.state) back.searchParams.set("state", params.state);
    const fail = (error: string) => {
      back.searchParams.set("error", error);
      redirect(ex, back.toString());
    };
    if (params.response_type !== "code") return fail("unsupported_response_type");
    if (params.code_challenge_method !== "S256" || !params.code_challenge)
      return fail("invalid_request");
    if (params.resource && params.resource !== this.resource) return fail("invalid_target");
    if (this.deny) return fail("access_denied");
    const code = token("notion-code");
    this.codes.set(code, {
      clientId: params.client_id!,
      redirectUri: params.redirect_uri!,
      challenge: params.code_challenge,
      used: false,
    });
    back.searchParams.set("code", code);
    redirect(ex, back.toString());
  }

  private issue(grant: NotionGrant, identity: boolean) {
    const accessToken = token("notion-at");
    this.accessTokens.set(accessToken, { grant, expiresAt: Date.now() + HOUR * 1000 });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: HOUR,
      refresh_token: grant.refreshToken,
      ...(identity
        ? {
            workspace_id: NOTION_WORKSPACE.id,
            workspace_name: NOTION_WORKSPACE.name,
            workspace_icon: null,
            bot_id: NOTION_WORKSPACE.botId,
            user_id: NOTION_WORKSPACE.userId,
            owner: { type: "user", user: { id: NOTION_WORKSPACE.userId } },
          }
        : {}),
    };
  }

  private token(ex: Exchange) {
    const body = form(ex);
    const grantType = body.get("grant_type") ?? "";
    this.tokenRequests.push(grantType);
    const clientId = body.get("client_id") ?? "";
    if (!this.clients.has(clientId)) return json(ex, 401, { error: "invalid_client" });
    const bad = (description: string) =>
      json(ex, 400, { error: "invalid_grant", error_description: description });
    if (body.get("resource") && body.get("resource") !== this.resource)
      return json(ex, 400, { error: "invalid_target" });
    if (grantType === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "");
      if (!code || code.used || code.clientId !== clientId) return bad("Invalid code.");
      code.used = true;
      if (code.redirectUri !== body.get("redirect_uri")) return bad("redirect_uri mismatch.");
      if (s256(body.get("code_verifier") ?? "") !== code.challenge)
        return bad("PKCE verification failed.");
      const grant: NotionGrant = {
        clientId,
        refreshToken: token("notion-rt"),
        rotated: new Set(),
        revoked: false,
      };
      this.grants.push(grant);
      return json(ex, 200, this.issue(grant, true));
    }
    if (grantType === "refresh_token") {
      const value = body.get("refresh_token") ?? "";
      const grant = this.grants.find(
        (entry) => entry.refreshToken === value || entry.rotated.has(value),
      );
      if (!grant)
        return OUR_TOKEN.test(value)
          ? bad("Invalid refresh token.")
          : json(ex, 503, { error: "temporarily_unavailable" });
      if (grant.revoked || grant.clientId !== clientId) return bad("The grant was revoked.");
      if (grant.rotated.has(value)) {
        // An old refresh token used again: someone may have stolen it, so the grant ends.
        grant.revoked = true;
        return bad("Refresh token reuse detected.");
      }
      grant.rotated.add(grant.refreshToken);
      grant.refreshToken = token("notion-rt");
      return json(ex, 200, this.issue(grant, false));
    }
    json(ex, 400, { error: "unsupported_grant_type" });
  }

  private revoke(ex: Exchange) {
    const value = form(ex).get("token") ?? "";
    const grant =
      this.grants.find((entry) => entry.refreshToken === value) ??
      this.accessTokens.get(value)?.grant;
    if (grant) grant.revoked = true;
    this.revocations.push(value);
    json(ex, 200, {});
  }

  private async mcp(ex: Exchange) {
    if (!this.live(bearer(ex))) {
      send(ex, 401, JSON.stringify({ error: "invalid_token" }), {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      return;
    }
    let body: unknown;
    try {
      body = ex.body.length ? JSON.parse(ex.body.toString("utf8")) : undefined;
    } catch {
      json(ex, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    const sessionId = ex.req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const transport = this.sessions.get(sessionId);
      if (!transport) {
        json(ex, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(ex.req, ex.res, body);
      return;
    }
    if (ex.method !== "POST" || !isInitializeRequest(body)) {
      json(ex, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no session" },
        id: null,
      });
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await this.server().connect(transport);
    await transport.handleRequest(ex.req, ex.res, body);
  }

  private url(entry: NotionPage) {
    return `https://www.notion.so/${entry.title.replace(/[^a-z0-9]+/gi, "-")}-${entry.id}`;
  }

  private find(value: unknown): NotionPage | null {
    const id = typeof value === "string" ? notionIdOf(value) : null;
    return id ? (this.pages.get(id) ?? null) : null;
  }

  private parentOf(raw: unknown): { id: string | null } | { error: string } {
    if (raw === undefined || raw === null) return { id: null };
    const parent = raw as Record<string, unknown>;
    const ref = parent.page_id ?? parent.database_id ?? parent.data_source_id;
    if (typeof ref !== "string") return { error: "Unsupported parent." };
    const found = this.find(ref);
    return found ? { id: found.id } : { error: `Could not find parent ${ref}.` };
  }

  private server(): McpServer {
    const mcp = new McpServer({ name: "Notion MCP (E2E stand-in)", version: "1.0.0" });
    const text = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
    });
    const failure = (message: string) => ({
      content: [{ type: "text" as const, text: message }],
      isError: true,
    });
    const tool = (
      name: (typeof NOTION_TOOL_NAMES)[number],
      description: string,
      shape: z.ZodRawShape,
      run: (args: Record<string, unknown>) => ReturnType<typeof text> | ReturnType<typeof failure>,
    ) =>
      mcp.registerTool(
        name,
        { description, inputSchema: z.looseObject(shape) },
        async (args: Record<string, unknown>) => {
          this.calls.push({ tool: name, args, at: Date.now() });
          return run(args);
        },
      );
    /** A write's answer: now, or as an async task to poll. */
    const written = (result: unknown) => {
      if (!this.asyncWrites) return text(result);
      const id = `task-${id16()}`;
      this.tasks.set(id, { result, polls: 0 });
      return text({ object: "async_task", id, status: "pending", poll_after_seconds: 1 });
    };

    tool("notion-search", "Search the workspace.", { query: z.string() }, (args) => {
      const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [...this.pages.values()].filter((entry) =>
        words.some((word) => `${entry.title} ${entry.content}`.toLowerCase().includes(word)),
      );
      return text({
        type: "workspace_search",
        results: [
          ...hits.map((entry) => ({
            id: dashed(entry.id),
            title: entry.title,
            url: this.url(entry),
            type: entry.kind,
            highlight: entry.content.slice(0, 120),
            timestamp: new Date().toISOString(),
          })),
          // A result from an app connected to Notion, which teammates mustn't get.
          ...(words.length
            ? [
                {
                  id: "slack-e2e-1",
                  title: `Slack: #general mentions ${words[0]}`,
                  url: "https://e2e.slack.com/archives/C1/p1",
                  type: "slack",
                },
              ]
            : []),
        ],
      });
    });
    tool("notion-fetch", "Fetch a page or database.", { id: z.string() }, (args) => {
      const entry = this.find(args.id);
      if (!entry) return failure(`Could not find page or database with ID: ${String(args.id)}`);
      return text({
        metadata: { type: entry.kind },
        title: entry.title,
        url: this.url(entry),
        text: `<page url="${this.url(entry)}">\n<properties>{"title":"${entry.title}"}</properties>\n<content>\n${entry.content}\n</content>\n</page>`,
      });
    });
    tool("notion-query-data-sources", "Query data sources.", {}, () => text({ results: [] }));
    tool("notion-get-comments", "Read a page's comments.", { page_id: z.string() }, (args) => {
      const entry = this.find(args.page_id);
      return text({
        comments: entry ? this.comments.filter((comment) => comment.pageId === entry.id) : [],
      });
    });
    tool("notion-get-users", "List people in the workspace.", {}, () =>
      text({
        results: [
          {
            id: NOTION_WORKSPACE.userId,
            type: "person",
            name: "E2E Owner",
            email: GOOGLE_USER.email,
          },
        ],
        has_more: false,
      }),
    );
    tool("notion-create-pages", "Create pages.", { pages: z.array(z.looseObject({})) }, (args) => {
      const parent = this.parentOf(args.parent);
      if ("error" in parent) return failure(parent.error);
      const made = (args.pages as Record<string, unknown>[]).map((input) => {
        const properties = (input.properties ?? {}) as Record<string, unknown>;
        const title = String(properties.title ?? properties.Title ?? "Untitled");
        const entry: NotionPage = {
          id: randomUUID().replace(/-/g, ""),
          title,
          parentId: parent.id,
          content: typeof input.content === "string" ? input.content : "",
          kind: "page",
          made: true,
        };
        this.pages.set(entry.id, entry);
        return { id: dashed(entry.id), url: this.url(entry), properties: { title } };
      });
      return written({ pages: made });
    });
    tool(
      "notion-update-page",
      "Change a page.",
      { page_id: z.string(), command: z.string() },
      (args) => {
        const entry = this.find(args.page_id);
        if (!entry) return failure(`Could not find page with ID: ${String(args.page_id)}`);
        const command = String(args.command);
        if (command === "update_properties") {
          const properties = (args.properties ?? {}) as Record<string, unknown>;
          if (typeof properties.title === "string") entry.title = properties.title;
        } else if (command === "replace_content") entry.content = String(args.new_str ?? "");
        else if (command === "insert_content_after" || command === "append_content")
          entry.content = `${entry.content}\n${String(args.new_str ?? args.content ?? "")}`;
        else return failure(`Unknown command: ${command}`);
        return written({ page_id: dashed(entry.id), url: this.url(entry) });
      },
    );
    tool(
      "notion-move-pages",
      "Move pages under a new parent.",
      { page_or_database_ids: z.array(z.string()), new_parent: z.looseObject({}) },
      (args) => {
        const parent = this.parentOf(args.new_parent);
        if ("error" in parent) return failure(parent.error);
        const moving = (args.page_or_database_ids as string[]).map((ref) => this.find(ref));
        if (moving.some((entry) => !entry)) return failure("Could not find a page to move.");
        for (const entry of moving) entry!.parentId = parent.id;
        return written({ result: `Moved ${moving.length} pages.` });
      },
    );
    tool("notion-duplicate-page", "Duplicate a page.", { page_id: z.string() }, (args) => {
      const entry = this.find(args.page_id);
      if (!entry) return failure(`Could not find page with ID: ${String(args.page_id)}`);
      const copy = { ...entry, id: randomUUID().replace(/-/g, ""), title: `${entry.title} (1)` };
      this.pages.set(copy.id, copy);
      return written({ page_id: dashed(copy.id), url: this.url(copy) });
    });
    tool("notion-create-database", "Create a database.", {}, (args) => {
      const parent = this.parentOf(args.parent);
      if ("error" in parent) return failure(parent.error);
      const entry: NotionPage = {
        id: randomUUID().replace(/-/g, ""),
        title: typeof args.title === "string" ? args.title : "Untitled database",
        parentId: parent.id,
        content: "",
        kind: "database",
        made: true,
      };
      this.pages.set(entry.id, entry);
      const source = randomUUID();
      return written({
        database: { id: dashed(entry.id), url: this.url(entry) },
        data_sources: [{ id: source, url: `collection://${source}` }],
      });
    });
    tool(
      "notion-update-data-source",
      "Change a data source.",
      { data_source_id: z.string() },
      (args) => written({ data_source_id: args.data_source_id, ok: true }),
    );
    tool("notion-create-comment", "Comment on a page.", {}, (args) => {
      const entry = this.find(args.page_id);
      if (!entry) return failure("Could not find the page to comment on.");
      const comment = JSON.stringify(args.rich_text ?? args.markdown ?? args.text ?? "");
      this.comments.push({ pageId: entry.id, text: comment });
      return written({ comment_id: randomUUID() });
    });
    tool("notion-get-async-task", "Check on a write.", { task_id: z.string() }, (args) => {
      const task = this.tasks.get(String(args.task_id));
      if (!task) return failure("No such task.");
      task.polls += 1;
      return text(
        task.polls >= 2
          ? { status: "succeeded", result: task.result }
          : { status: "in_progress", poll_after_seconds: 1 },
      );
    });
    return mcp;
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((transport) => transport.close()));
    this.sessions.clear();
  }
}
