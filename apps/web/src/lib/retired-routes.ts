/**
 * JSON reads the browser used before they became API procedures. A tab still running that older
 * code polls `/api/state` every 15 seconds. Its own code sends it to `/login` on a 401, and the
 * login page sends a signed-in owner home, so answering 401 reloads the tab onto current code.
 * Newer tabs reload by themselves on a deploy (`apps/web/src/lib/client/deployment.ts`).
 *
 * Remove after 2026-12-01, once no tab from before can still be open.
 */
const RETIRED = [
  "accounts/setup",
  "activity",
  "approvals",
  "bots/*/lessons", // vocabulary: allow (an old URL)
  "bots/*/spending", // vocabulary: allow (an old URL)
  "briefing",
  "chats/*",
  "connections",
  "email",
  "files/list",
  "model-access",
  "notifications",
  "pages",
  "pages/*",
  "pages/versions/*/link",
  "profile",
  "push",
  "rate-limits",
  "runs/*",
  "schedules",
  "schedules/*/runs",
  "screens/frames",
  "search",
  "search/pages",
  "skills",
  "state",
  "tasks",
  "telegram",
  "triggers",
  "triggers/*/runs",
  "usage",
  "vault",
];

const PATTERNS = RETIRED.map((path) => new RegExp(`^${path.replaceAll("*", "[^/]+")}$`));

/** True for a path under `/api/` (without that prefix) that only old tabs still read. */
export function isRetiredRead(segments: readonly string[]): boolean {
  const path = segments.join("/");
  return PATTERNS.some((pattern) => pattern.test(path));
}
