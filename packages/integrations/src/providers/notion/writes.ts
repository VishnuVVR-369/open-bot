// Notion's change tools: each works out a change, frozen for approval, that the runner sends;
// changes to what teammates made, or in their area, count as theirs.
import { accountResources } from "@open-bot/db";
import {
  NOTION_AREA_SETTING,
  type AccountActionPreview,
  type ActionEffect,
} from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { notionEffect, notionId, notionParent } from "./effects";
import type {
  PreparedAction,
  ToolContext,
  IntegrationHost,
  ResolvedConnection,
} from "../../core/adapter";
import { excerpt } from "./results";
import { passthrough, schemas } from "./tools";

/** A link to a Notion page from its id. */
function pageUrl(id: string): string {
  return `https://www.notion.so/${id}`;
}

function titleOf(page: Record<string, unknown>): string {
  const properties = page.properties as Record<string, unknown> | undefined;
  const title = properties?.title ?? properties?.Title ?? properties?.Name;
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled";
}

/** What teammates made, and their area: changes there count as theirs, not yours. */
async function ours(
  host: IntegrationHost,
  connection: ResolvedConnection["connection"],
): Promise<(id: string) => boolean> {
  const owned = await host.db
    .select({ externalId: accountResources.externalId })
    .from(accountResources)
    .where(eq(accountResources.connectionId, connection.id));
  const ids = new Set(owned.map((row) => row.externalId));
  const setting = connection.settings[NOTION_AREA_SETTING];
  const area = setting ? notionId(setting.id) : null;
  if (area) ids.add(area);
  return (id) => ids.has(id);
}

export async function prepare(
  host: IntegrationHost,
  tool: string,
  notionTool: string,
  tc: ToolContext,
): Promise<PreparedAction> {
  const { account: _account, ...args } = (
    schemas[tool as keyof typeof schemas] ?? passthrough
  ).parse(tc.args);
  const isOurs = await ours(host, tc.resolved.connection);
  const effect: ActionEffect = notionEffect(tool, args, isOurs);
  const workspace = tc.resolved.account.display;
  const describe = describeChange(tool, args);
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
function describeChange(
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
