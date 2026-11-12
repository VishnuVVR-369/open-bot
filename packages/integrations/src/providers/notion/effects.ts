import type { ActionEffect } from "@open-bot/domain";

/** What a Notion write targets and does, from its checked arguments. When unsure, it is outward. */

/** A Notion id as stored: 32 lower-case hex digits, without dashes. */
export function notionId(value: string): string | null {
  const match =
    /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i.exec(
      value,
    );
  return match ? match.slice(1).join("").toLowerCase() : null;
}

/** What a Notion write targets, from its arguments. */
export interface NotionTargets {
  /** The parent new pages or databases go under; null for none (a private page). */
  parent: {
    kind: "page" | "data_source" | "database" | "teamspace" | "memory";
    id: string | null;
  } | null;
  /** Existing pages or data sources the call changes. */
  targets: string[];
}

/** The parent of a create call, as Notion's tools take it. */
export function notionParent(raw: unknown): NotionTargets["parent"] | "unknown" {
  if (raw === undefined || raw === null) return null;
  if (raw === "memory") return { kind: "memory", id: null };
  if (typeof raw === "string") {
    const id = notionId(raw);
    return id ? { kind: "page", id } : "unknown";
  }
  if (typeof raw !== "object") return "unknown";
  const parent = raw as Record<string, unknown>;
  const keys: [string, "page" | "data_source" | "database" | "teamspace"][] = [
    ["page_id", "page"],
    ["data_source_id", "data_source"],
    ["database_id", "database"],
    ["teamspace_id", "teamspace"],
  ];
  for (const [key, kind] of keys) {
    const value = parent[key];
    if (typeof value === "string") {
      const id = notionId(value);
      return id ? { kind, id } : "unknown";
    }
  }
  return "unknown";
}

/**
 * The effect of a Notion write. `isOurs` says whether an id is a page or database a teammate
 * created, or inside your teammates' area.
 */
export function notionEffect(
  tool: string,
  args: Record<string, unknown>,
  isOurs: (id: string) => boolean,
): ActionEffect {
  switch (tool) {
    case "create_pages":
    case "create_database": {
      const parent = notionParent(args.parent);
      if (parent === "unknown") return "outward";
      // No parent, or a draft: a private page in your workspace that only you see.
      if (parent === null || parent.kind === "memory") return "private_write";
      if (parent.kind === "teamspace") return "outward";
      return parent.id && isOurs(parent.id) ? "write" : "outward";
    }
    case "update_page": {
      const id = typeof args.page_id === "string" ? notionId(args.page_id) : null;
      return id && isOurs(id) ? "write" : "outward";
    }
    case "update_database": {
      const id = typeof args.data_source_id === "string" ? notionId(args.data_source_id) : null;
      return id && isOurs(id) ? "write" : "outward";
    }
    // Moves and duplicates change who can see a page; comments notify people.
    default:
      return "outward";
  }
}
