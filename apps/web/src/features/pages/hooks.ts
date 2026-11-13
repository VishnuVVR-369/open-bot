"use client";

import type { PageTheme } from "@open-bot/domain";
import { skipToken, useQuery } from "@tanstack/react-query";
import { isNotFound } from "@/lib/client/errors";
import { orpc } from "@/lib/client/rpc";

export function usePages() {
  return useQuery(orpc.pages.list.queryOptions());
}

export function usePage(pageId: string) {
  return useQuery(
    orpc.pages.get.queryOptions({
      input: { pageId },
      retry: (count, error) => !isNotFound(error) && count < 2,
    }),
  );
}

/**
 * Where to show a version. Links work for a few minutes, so a page reopened later gets a new one.
 * Not cached with the page lists: the `pages` event never refreshes it.
 */
export function usePageLink(versionId: string | null, theme: PageTheme, ask: boolean) {
  return useQuery(
    orpc.pages.open.queryOptions({
      input: versionId === null ? skipToken : { versionId, theme, ask },
      // Loaded once into the frame, which keeps working after the link expires. Coming back to it
      // later (another theme and back, or the page again) gets a new link once this one is near its end.
      staleTime: (query) =>
        query.state.data
          ? Math.max(0, Date.parse(query.state.data.expiresAt) - Date.now() - 60_000)
          : 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );
}
