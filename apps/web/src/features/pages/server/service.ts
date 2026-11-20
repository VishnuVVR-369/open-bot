import "server-only";
import type { ApiInputs, PageDetail, PageLink, PageSummary } from "@open-bot/api";
import { pages, pageVersions } from "@open-bot/db";
import { pageViewQuery } from "@open-bot/domain";
import { PAGE_LINK_TTL_SECONDS, pageVersionUrl } from "@open-bot/domain/server";
import { desc, eq, sql } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { db } from "@/lib/server/db";
import { serverEnv } from "@/lib/server/env";
import { worker } from "@/lib/server/worker";

const summaryColumns = {
  id: pages.id,
  title: pages.title,
  summary: pages.summary,
  teammateId: pages.teammateId,
  chatId: pages.chatId,
  pinned: pages.pinned,
  versionCount: pages.versionCount,
  versionId: pageVersions.id,
  version: pageVersions.number,
  size: pageVersions.size,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
  sourcePath: pages.sourcePath,
};

/** Pages with their latest version. */
function summaries() {
  return db
    .select(summaryColumns)
    .from(pages)
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId));
}

type SummaryRow = Awaited<ReturnType<typeof summaries>>[number];

function toSummary(row: SummaryRow): PageSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    teammateId: row.teammateId,
    chatId: row.chatId,
    pinned: row.pinned,
    versionCount: row.versionCount,
    versionId: row.versionId,
    version: row.version,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPages(): Promise<PageSummary[]> {
  const rows = await summaries().orderBy(desc(pages.pinned), desc(pages.updatedAt)).limit(500);
  return rows.map(toSummary);
}

export async function getPage(pageId: string): Promise<PageDetail> {
  const [row] = await summaries().where(eq(pages.id, pageId));
  if (!row) throw new ApiError("NOT_FOUND", "That page was deleted.");
  const versions = await db
    .select({
      id: pageVersions.id,
      number: pageVersions.number,
      title: pageVersions.title,
      summary: pageVersions.summary,
      note: pageVersions.note,
      teammateId: pageVersions.teammateId,
      runId: pageVersions.runId,
      size: pageVersions.size,
      issues: pageVersions.issues,
      createdAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.number));
  return {
    ...toSummary(row),
    sourcePath: row.sourcePath,
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      title: version.title,
      summary: version.summary,
      note: version.note,
      teammateId: version.teammateId,
      runId: version.runId,
      size: version.size,
      warnings: version.issues.map((issue) => issue.message),
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

/** A link to one version on the pages origin, good for a few minutes. */
export async function openPage(input: ApiInputs["pages"]["open"]): Promise<PageLink> {
  const [version] = await db
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .where(eq(pageVersions.id, input.versionId));
  if (!version) throw new ApiError("NOT_FOUND", "That page was deleted.");
  // The pages service refuses to start without it, so a missing one here is a setup mistake.
  if (serverEnv.pagesSecret.length < 32)
    throw new Error(
      "Pages can't open: set PAGES_SECRET on the web app to the same value as on the pages service.",
    );
  const query = pageViewQuery({ theme: input.theme, ask: input.ask });
  return {
    url: pageVersionUrl(serverEnv.pagesUrl, version.id, serverEnv.pagesSecret, query),
    expiresAt: new Date(Date.now() + PAGE_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}

/** The worker pins and deletes pages (it owns them, see packages/db/src/owners.ts). */
export async function pinPage({ pageId, pinned }: ApiInputs["pages"]["pin"]) {
  return worker.pages.pin({ pageId, pinned });
}

export async function removePage({ pageId }: ApiInputs["pages"]["remove"]) {
  return worker.pages.remove({ pageId });
}

/** A version's small picture for cards, in the theme asked for when there is one. */
export async function pageThumbnail(
  versionId: string,
  theme: "light" | "dark" = "light",
): Promise<Buffer | null> {
  const [row] = await db
    .select({ light: pageVersions.thumbnail, dark: pageVersions.thumbnailDark })
    .from(pageVersions)
    .where(eq(pageVersions.id, versionId));
  if (!row) return null;
  return (theme === "dark" ? row.dark : null) ?? row.light;
}

/**
 * A version as a file to keep. Its libraries load from the pages service, so it still works
 * opened from a download folder (while that service is up).
 */
export async function pageDownload(
  versionId: string,
): Promise<{ title: string; number: number; html: string } | null> {
  const [row] = await db
    .select({ title: pageVersions.title, number: pageVersions.number, html: pageVersions.html })
    .from(pageVersions)
    .where(eq(pageVersions.id, versionId));
  if (!row) return null;
  return {
    title: row.title,
    number: row.number,
    html: row.html.replace(/(["'(]\s*)\/lib\//g, `$1${serverEnv.pagesUrl}/lib/`),
  };
}

/** Pages whose title, summary or text contain the query, for search. */
export async function searchPages(query: string, limit = 6): Promise<PageSummary[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await summaries()
    .where(
      sql`(${pages.title} ilike ${pattern} or ${pages.summary} ilike ${pattern} or ${pageVersions.text} ilike ${pattern})`,
    )
    .orderBy(desc(pages.updatedAt))
    .limit(limit);
  return rows.map(toSummary);
}
