import type { TeammateProfileView } from "@open-bot/api";
import { errorMessage, isGone, isStateConflict } from "../../lib/errors";
import { rebaseProfile, type ProfileDraft } from "./profile";

/**
 * The profile editor's decisions, apart from the screen: when the form follows a fresher copy,
 * what a refused save leads to, and when Save is on.
 */

/**
 * The form after a fresher copy of the profile came in (it changed on the web, say). Not while a
 * save is on its way: the form is frozen then, and the save's own answer comes next.
 */
export const followProfile = (
  draft: ProfileDraft,
  view: TeammateProfileView,
  saving: boolean,
): ProfileDraft => (saving ? draft : rebaseProfile(draft, view));

/**
 * What a refused save means: the teammate is gone (archived), the profile changed since the form
 * began (read it again and rebase), or the save failed for another reason, said in words.
 */
export type SaveRefusal =
  { kind: "gone" } | { kind: "changed" } | { kind: "failed"; problem: string };

export function saveRefusal(error: unknown): SaveRefusal {
  if (isGone(error)) return { kind: "gone" };
  if (isStateConflict(error)) return { kind: "changed" };
  return { kind: "failed", problem: errorMessage(error, "Couldn't save the profile.") };
}

/** The editor once a refused save's fresh read came back. */
export interface AfterRefusal {
  draft: ProfileDraft;
  /** The form took in the newer profile, with your changes on top, for you to look over. */
  rebased: boolean;
  gone: boolean;
  problem: string | null;
}

/**
 * After a save refused as changed meanwhile: the fresh read rebases the form, keeping what you
 * changed on top. A failed read keeps the form as it was and says why, or that the teammate is
 * gone.
 */
export function afterRefusal(
  draft: ProfileDraft,
  read: { ok: true; view: TeammateProfileView } | { ok: false; error: unknown },
): AfterRefusal {
  if (read.ok)
    return { draft: rebaseProfile(draft, read.view), rebased: true, gone: false, problem: null };
  if (isGone(read.error)) return { draft, rebased: false, gone: true, problem: null };
  return {
    draft,
    rebased: false,
    gone: false,
    problem: errorMessage(read.error, "Couldn't load the latest version."),
  };
}

/** Whether Save is on: online, not already saving, something changed and fine, and still there. */
export const canSaveProfile = (state: {
  online: boolean;
  saving: boolean;
  changed: boolean;
  problem: string | null;
  gone: boolean;
}) => state.online && !state.saving && state.changed && !state.problem && !state.gone;

/**
 * What the cached profile becomes after a save answered with `saved`. Written only over the copy
 * the save was based on (or none); a newer copy that came in meanwhile, someone else's change on
 * top of ours, is kept, and read again in case it's from before ours after all.
 */
export function cacheAfterSave(
  cached: TeammateProfileView | undefined,
  sentRevision: string,
  saved: TeammateProfileView,
): { write: TeammateProfileView } | { keep: true; refetch: boolean } {
  if (!cached || cached.revision === sentRevision) return { write: saved };
  return { keep: true, refetch: cached.revision !== saved.revision };
}
