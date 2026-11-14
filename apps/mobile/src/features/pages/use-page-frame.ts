import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { isLinkFresh, pageLoadFailure } from "./pages";
import { queryKeys } from "../../lib/query";

/**
 * The link the page viewer loads a version through, and what became of loading it. `onGone` runs
 * when the pages service no longer has the page, so the caller can check whether it was deleted.
 */
export function usePageFrame(
  versionId: string | null,
  theme: "light" | "dark",
  onGone: () => void,
) {
  const link = useQuery({
    queryKey: queryKeys.pageLink(versionId ?? "", theme),
    queryFn: () => api.pages.open({ versionId: versionId!, theme, ask: true }),
    enabled: versionId !== null,
    // Loaded once into the page; a fresh one is only needed to load it again.
    staleTime: Infinity,
    gcTime: 60_000,
  });
  // The link the page is showing. It only changes with the version or the theme, or when you
  // load the page again: a new link for the same page (say, after the app reconnects and
  // refreshes everything) would otherwise reload it and lose your place.
  const frameKey = versionId ? `${versionId}|${theme}` : null;
  const [frame, setFrame] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!frameKey || !link.data) return;
    const next = { key: frameKey, url: link.data.url };
    setFrame((current) => (current?.key === frameKey ? current : next));
  }, [frameKey, link.data]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // A link the pages service turned down gets one new link by itself; after that, you decide.
  const renewed = useRef(false);

  /** Load the page again, with a new link if this one is out (or nearly), or `fresh` asks. */
  const reload = useCallback(
    async (fresh = false) => {
      setError(null);
      let next = link.data;
      if (fresh || !next || !isLinkFresh(next)) next = (await link.refetch()).data;
      if (next && frameKey) setFrame({ key: frameKey, url: next.url });
      setReloads((n) => n + 1);
    },
    [link, frameKey],
  );

  const url = frame && frame.key === frameKey ? frame.url : null;
  return {
    url,
    /** Changes whenever the page must load again, even at the same address. */
    reloads,
    linkError: link.error,
    error,
    loading: !link.error && !error && loadedUrl !== url,
    reload,
    /** A new version is on its way in: show the spinner until it loads. */
    forget: () => setLoadedUrl(null),
    onLoadEnd: () => setLoadedUrl(url),
    onHttpError: (status: number) => {
      const failure = pageLoadFailure(status, renewed.current);
      if (failure.kind === "renew") {
        // An expired link: get a new one and load again, once.
        renewed.current = true;
        void reload(true);
      } else if (failure.kind === "recheck") onGone();
      else setError(failure.message);
    },
    onError: () => setError("Couldn't reach open-bot's pages service. Check your connection."),
  };
}
