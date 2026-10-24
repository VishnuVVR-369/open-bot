/** How much a bot may do without asking. */
export type Autonomy = "full" | "risky" | "everything";

export const AUTONOMY_OPTIONS: { value: Autonomy; label: string; description: string }[] = [
  {
    value: "full",
    label: "Full auto",
    description:
      "Works without asking. It still asks before anything you mark as needing approval.",
  },
  {
    value: "risky",
    label: "Ask before risky actions",
    description:
      "Asks before sending, publishing, buying, deleting or changing settings on your behalf.",
  },
  {
    value: "everything",
    label: "Ask before every command",
    description: "Asks before each shell command and file change. Slow, but you see everything.",
  },
];

/** A curated palette for bot avatars. Each bot gets one as its accent color. */
export const BOT_COLORS = [
  "#7C5CFF",
  "#2E9BFF",
  "#14B8A6",
  "#22C55E",
  "#EAB308",
  "#F97316",
  "#EF4444",
  "#EC4899",
] as const;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "bot"
  );
}

/** Paths inside the shared computer. */
export const COMPUTER_PATHS = {
  botsRoot: "/home/bot/bots",
  shared: "/home/bot/shared",
  downloads: "/home/bot/shared/downloads",
  codexHome: "/home/bot/.codex",
  workspace: (slug: string) => `/home/bot/bots/${slug}`,
} as const;

/**
 * Why a path on the computer can't be deleted, or null when it can: the folders that keep the
 * computer working, and the workspaces of teammates who aren't archived.
 */
export function undeletablePath(path: string, activeBotSlugs: Iterable<string>): string | null {
  const fixed = [
    "/home/bot",
    COMPUTER_PATHS.botsRoot,
    COMPUTER_PATHS.shared,
    COMPUTER_PATHS.downloads,
    `${COMPUTER_PATHS.shared}/uploads`,
  ];
  if (fixed.includes(path) || path.startsWith("/home/bot/.agents"))
    return "That folder is part of how the computer works.";
  const workspace = /^\/home\/bot\/bots\/([^/]+)$/.exec(path);
  if (workspace && new Set(activeBotSlugs).has(workspace[1]!))
    return "That's a teammate's workspace. Archive them first.";
  return null;
}

/** The largest file you can attach or upload to the computer. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "40 MB";

/** Where the computer's browser traffic leaves from. */
export type EgressModeSetting = "off" | "prefer" | "require";

export const EGRESS_OPTIONS: { value: EgressModeSetting; label: string; description: string }[] = [
  {
    value: "prefer",
    label: "Prefer my desktop",
    description:
      "Browse from your home connection while the desktop app is open, and go direct when it is closed.",
  },
  {
    value: "require",
    label: "Only through my desktop",
    description:
      "Never browse from the cloud's IP. While the desktop app is closed, the browser can't load pages.",
  },
  {
    value: "off",
    label: "Off",
    description: "Always browse straight from the cloud computer.",
  },
];

/** The longest the "About you" profile every teammate reads can be. */
export const MAX_ABOUT_ME_CHARS = 8000;

/** The longest a lesson from your feedback can be. */
export const MAX_LESSON_CHARS = 500;

/** How many of its newest lessons a teammate reads. */
export const MAX_LESSONS = 40;
