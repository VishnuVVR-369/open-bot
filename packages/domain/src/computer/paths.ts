/** Paths inside the shared computer. */
export const COMPUTER_PATHS = {
  teammatesRoot: "/home/bot/bots",
  shared: "/home/bot/shared",
  downloads: "/home/bot/shared/downloads",
  codexHome: "/home/bot/.codex",
  workspace: (slug: string) => `/home/bot/bots/${slug}`,
} as const;

/**
 * Why a path on the computer can't be deleted, or null when it can: the folders that keep the
 * computer working, and the workspaces of teammates who aren't archived.
 */
export function undeletablePath(
  path: string,
  activeTeammateSlugs: Iterable<string>,
): string | null {
  const fixed = [
    "/home/bot",
    COMPUTER_PATHS.teammatesRoot,
    COMPUTER_PATHS.shared,
    COMPUTER_PATHS.downloads,
    `${COMPUTER_PATHS.shared}/uploads`,
  ];
  if (fixed.includes(path) || path.startsWith("/home/bot/.agents"))
    return "That folder is part of how the computer works.";
  const workspace = /^\/home\/bot\/bots\/([^/]+)$/.exec(path);
  if (workspace && new Set(activeTeammateSlugs).has(workspace[1]!))
    return "That's a teammate's workspace. Archive them first.";
  return null;
}
