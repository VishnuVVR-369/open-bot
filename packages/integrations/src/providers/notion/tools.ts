// Notion's tools: which of Notion's own each forwards to, the arguments open-bot checks (zod),
// and how each is described to Codex.
import { z } from "zod";
import { tool, type NamespaceTool } from "../../core/tool-spec";

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

export const READS = new Set(["search", "fetch", "query_database", "get_comments", "get_users"]);

const accountArg = z.string().optional();
/** Notion's own arguments pass through; these are the ones open-bot checks. */
export const passthrough = z.object({ account: accountArg }).passthrough();
const pageRef = z.string().trim().min(1);

export const schemas = {
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

const passes = "Other arguments of Notion's tool of the same name pass through as they are.";

export const NOTION_TOOLS: NamespaceTool[] = [
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
