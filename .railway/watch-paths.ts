// Which pushes to main redeploy which Railway service.
// A service redeploys only when a push changes a file under one of its folders or a root
// build file. `watch-paths.test.ts` checks every list against the workspace dependency graph
// and the computer's Dockerfile, so a new workspace dependency must be added here too.

export type DeployedService = "web" | "worker" | "pages" | "computer";

/** Repo-relative folders whose contents end up in each service's build. */
export const SERVICE_FOLDERS: Record<DeployedService, readonly string[]> = {
  web: [
    "apps/web",
    "packages/agent",
    "packages/api",
    "packages/chat-core",
    "packages/db",
    "packages/domain",
    "packages/integrations",
    "packages/memory",
  ],
  worker: [
    "apps/worker",
    "packages/agent",
    "packages/api",
    "packages/db",
    "packages/domain",
    "packages/egress",
    "packages/integrations",
    "packages/memory",
    "packages/page-kit",
  ],
  pages: ["apps/pages", "packages/db", "packages/page-kit", "packages/domain"],
  computer: [
    "images/computer",
    "apps/botd",
    "packages/api",
    "packages/egress",
    "packages/page-kit",
    "packages/domain",
  ],
};

/** Root files every build reads: the install inputs and the shared compiler options. */
export const ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
] as const;

/** Root folders every build reads: `pnpm install` applies the dependency patches in `patches/`. */
export const ROOT_FOLDERS = ["patches"] as const;

/** Files inside watched folders that never reach a build. Negations must come last. */
export const IGNORED = ["AGENTS.md", "CLAUDE.md", "*.test.ts", "*.test.tsx"] as const;

/** Gitignore-style patterns, rooted at the repo root, for a service's `build.watchPatterns`. */
export function watchPatterns(service: DeployedService): string[] {
  return [
    ...ROOT_FILES.map((file) => `/${file}`),
    ...ROOT_FOLDERS.map((folder) => `/${folder}/**`),
    ...SERVICE_FOLDERS[service].map((folder) => `/${folder}/**`),
    ...IGNORED.map((name) => `!**/${name}`),
  ];
}
