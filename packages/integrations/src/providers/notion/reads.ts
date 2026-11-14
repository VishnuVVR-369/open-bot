// Notion's read tools: they answer the teammate directly.
import { outsideData } from "@open-bot/domain";
import { AccountToolError } from "../../core/errors";
import { notionId } from "./effects";
import type { ToolContext, ToolResult } from "../../core/adapter";
import { type NotionMcp } from "./mcp";
import { excerpt, resultData, resultText } from "./results";
import { passthrough, schemas } from "./tools";

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

function cap(text: string): string {
  return text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n[… cut]` : text;
}

export async function read(
  mcp: NotionMcp,
  tool: string,
  notionTool: string,
  tc: ToolContext,
): Promise<ToolResult> {
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
  const result = await mcp.callTool(tc.resolved.account.id, tc.tokens, notionTool, args, "read");
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
