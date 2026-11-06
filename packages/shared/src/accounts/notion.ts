import type {
  AuthProviderDefinition,
  ConnectionSettingValue,
  IntegrationDefinition,
} from "./types";

/** Notion: its hosted MCP server, which open-bot registers itself with. */
export const NOTION_PROVIDER = {
  id: "notion",
  label: "Notion",
  accountLabel: "Notion workspace",
  client: "automatic",
  baseScopes: [],
  // Notion's refresh tokens stop working this long after you first connected, and after 30 days
  // without a refresh.
  grantMaxDays: 180,
  idleExpiryDays: 30,
  revokeHint: "Remove open-bot under Connections in Notion's settings.",
} as const satisfies AuthProviderDefinition;

/**
 * Your teammates' area in Notion, from a link to its page (or the page's id): the page id from the
 * link's path, since a `?v=` in the query is a view's, and the title from its slug.
 */
export function parseNotionAreaLink(link: string): ConnectionSettingValue | null {
  const trimmed = link.trim();
  let path = trimmed;
  let slug = "";
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/(^|\.)notion\.(so|site|com)$/i.test(url.hostname)) return null;
    path = url.pathname;
    const last = path.split("/").pop() ?? "";
    try {
      slug = decodeURIComponent(last);
    } catch {
      slug = last;
    }
  }
  const ids = [
    ...path.matchAll(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi),
  ];
  const found = ids[ids.length - 1];
  if (!found) return null;
  const id = found[0].replace(/-/g, "").toLowerCase();
  const title = slug
    .replace(/-?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "")
    .replace(/-/g, " ")
    .trim();
  return { id, url: `https://www.notion.so/${id}`, title: title || "Teammates' area" };
}

/** The connection setting that holds the teammates' area. */
export const NOTION_AREA_SETTING = "area";

export const NOTION = {
  kind: "notion",
  provider: "notion",
  namespace: "notion",
  label: "Notion",
  description: "Teammates search and read your workspace, and write pages.",
  icon: "notebook",
  capabilities: [
    {
      capability: "read",
      label: "Search and read",
      description: "Everything you can see in the workspace.",
      required: true,
      defaultOn: true,
      can: "search and read pages",
      short: "Reads pages",
    },
    {
      capability: "write",
      label: "Write pages",
      description:
        "Create private pages and pages in the teammates' area. Anything others can see asks you first.",
      defaultOn: true,
      can: "create and change pages (anything others can see asks the user)",
      short: "writes pages",
    },
  ],
  tools: [
    { name: "search", label: "Search Notion", capability: "read" },
    { name: "fetch", label: "Read Notion pages", capability: "read" },
    { name: "query_database", label: "Read Notion databases", capability: "read" },
    { name: "get_comments", label: "Read Notion comments", capability: "read" },
    { name: "get_users", label: "List Notion people", capability: "read" },
    { name: "create_pages", label: "Create Notion pages", capability: "write" },
    { name: "update_page", label: "Change Notion pages", capability: "write" },
    { name: "move_pages", label: "Move Notion pages", capability: "write" },
    { name: "duplicate_page", label: "Duplicate Notion pages", capability: "write" },
    { name: "create_database", label: "Create Notion databases", capability: "write" },
    { name: "update_database", label: "Change Notion databases", capability: "write" },
    { name: "add_comment", label: "Comment in Notion", capability: "write" },
  ],
  settings: [
    {
      key: NOTION_AREA_SETTING,
      label: "Teammates' area",
      placeholder: "https://www.notion.so/acme/Teammates-1a2b…",
      help: "A page where teammates add and change pages without asking. Leave empty to ask about every shared page.",
      invalid: "Paste a link to a Notion page, like notion.so/acme/Teammates-1a2b….",
      noun: "area",
      parse: parseNotionAreaLink,
      instruct: (area) =>
        `your area is the page "${area.title}"${area.url ? ` (${area.url})` : ""}: create your pages under it`,
    },
  ],
  connectNote:
    "Notion grants access to everything you can see in the workspace you pick, not to chosen pages. Teammates write freely only in pages they made and in a teammates' area you can set after connecting; anything else asks you first.",
} as const satisfies IntegrationDefinition;
