import type { PageDetail } from "@open-bot/api";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { haptics } from "./haptics";
import { newerVersion, openingVersion } from "./pages";

/**
 * The version on screen, and the newest one you know about: a newer one offers itself until you
 * show it or dismiss it. Opens at the version the link's `v` names. Picking a version keeps it in
 * the link, so going back and forth keeps your place.
 */
export function usePageVersions(page: PageDetail | undefined, asked: string | undefined) {
  const [shownId, setShownId] = useState<string | null>(null);
  const [knownLatest, setKnownLatest] = useState<string | null>(null);
  useEffect(() => {
    if (!page || shownId) return;
    setShownId(openingVersion(page, asked));
    setKnownLatest(page.versionId);
  }, [page, shownId, asked]);
  const shown = page?.versions.find((version) => version.id === shownId) ?? null;

  const newer = useMemo(
    () => (page && shown ? newerVersion(page, shown.id, knownLatest) : null),
    [page, shown, knownLatest],
  );

  /** Show a version; returns whether it did, so the caller can reset what the old one loaded. */
  const pick = (versionId: string) => {
    if (!page) return false;
    haptics.tap();
    setShownId(versionId);
    setKnownLatest(page.versionId);
    router.setParams({ v: versionId === page.versionId ? undefined : versionId });
    return true;
  };
  const dismissNewer = () => {
    if (page) setKnownLatest(page.versionId);
  };

  return { shown, newer, pick, dismissNewer };
}
