/**
 * Web addresses that were renamed, and how their old forms keep working. Bookmarks, links pasted
 * into notes or chats, and notifications sent before the rename still use the old ones, so they
 * stay for good. `next.config.ts` serves the redirects.
 */

/**
 * Permanent (308) redirects. The id and any sub-path carry over, and Next.js passes the query
 * string through: an old link to a teammate's memory tab opens `/teammates/<id>?tab=memory`.
 */
export const RENAMED_ROUTES = [
  {
    source: "/bots/:path*", // vocabulary: allow (an old URL)
    destination: "/teammates/:path*",
    permanent: true,
  },
  {
    source: "/api/bots/:teammateId/export", // vocabulary: allow (an old URL)
    destination: "/api/teammates/:teammateId/export",
    permanent: true,
  },
] as const;

/**
 * The teammate whose memory `/api/memory` exports, or null for everyone's. The parameter had the
 * old name before the rename, and a saved link with it still downloads the same file.
 */
export function memoryExportTeammateId(params: URLSearchParams): string | null {
  return params.get("teammateId") || params.get("botId") || null; // vocabulary: allow (an old URL)
}
