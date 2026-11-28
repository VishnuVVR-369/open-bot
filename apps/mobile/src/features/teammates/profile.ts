import type { TeammateProfileView, TeammateSummary } from "@open-bot/api";
import { teammateProfileSchema, type TeammateProfile } from "@open-bot/domain";

/**
 * Editing a teammate's profile on the phone: the form, what changed in it, and how it follows the
 * profile as it changes elsewhere (on the web, by a teammate, or by accepting its suggested
 * instructions) without losing what you typed or silently replacing what someone else wrote.
 */

export type ProfileForm = TeammateProfile;
export type ProfileField = keyof ProfileForm;

export const PROFILE_FIELDS: readonly ProfileField[] = [
  "name",
  "role",
  "instructions",
  "color",
  "emoji",
  "autonomy",
];

/** What each field is called where the editor tells you about it. */
export const FIELD_LABELS: Record<ProfileField, string> = {
  name: "name",
  role: "job",
  instructions: "responsibilities",
  color: "color",
  emoji: "emoji",
  autonomy: "when they ask you first",
};

/** The longest name and job, as the shared profile rules have them. */
export const NAME_MAX = 40;
export const ROLE_MAX = 80;

/** The form, the profile it started from, and that profile's revision, which a save sends back. */
export interface ProfileDraft {
  start: ProfileForm;
  revision: string;
  form: ProfileForm;
  /**
   * Fields you changed that were also changed elsewhere since you began: saving replaces what was
   * written there with yours, so the editor says so.
   */
  clashes: ProfileField[];
}

// The server trims a name and a job, so spaces around them aren't a change.
const trimmed = (field: ProfileField) => field === "name" || field === "role";
const same = (field: ProfileField, a: ProfileForm, b: ProfileForm) =>
  trimmed(field) ? a[field].trim() === b[field].trim() : a[field] === b[field];

export function profileDraft(
  view: Pick<TeammateProfileView, "profile" | "revision">,
): ProfileDraft {
  return { start: view.profile, revision: view.revision, form: view.profile, clashes: [] };
}

/** Each field the form changed from where it started. */
export function changedFields(draft: Pick<ProfileDraft, "start" | "form">): ProfileField[] {
  return PROFILE_FIELDS.filter((field) => !same(field, draft.start, draft.form));
}

export const profileChanged = (draft: Pick<ProfileDraft, "start" | "form">) =>
  changedFields(draft).length > 0;

/**
 * A fresher copy of the profile: what you haven't touched follows it, and what you changed stays
 * yours. A field you changed that was also changed there, to something else, is a clash, kept
 * until you save, give it up, or change it back.
 */
export function rebaseProfile(
  draft: ProfileDraft,
  fresh: Pick<TeammateProfileView, "profile" | "revision">,
): ProfileDraft {
  if (fresh.revision === draft.revision) return draft;
  const changed = changedFields(draft);
  const theirs = fresh.profile;
  const form = { ...theirs };
  for (const field of changed) (form as Record<ProfileField, string>)[field] = draft.form[field];
  const clashes = changed.filter(
    (field) =>
      // Still yours to save over theirs: it clashed before, or it changed there just now.
      !same(field, theirs, draft.form) &&
      (draft.clashes.includes(field) || !same(field, theirs, draft.start)),
  );
  return { start: theirs, revision: fresh.revision, form, clashes };
}

/** Gives up your change to a field that clashed, for what was saved elsewhere. */
export function takeTheirs(draft: ProfileDraft, field: ProfileField): ProfileDraft {
  return {
    ...draft,
    form: { ...draft.form, [field]: draft.start[field] },
    clashes: draft.clashes.filter((entry) => entry !== field),
  };
}

/** Sets fields in the form; a clash on a field changed back to what's saved goes away. */
export function editProfile(draft: ProfileDraft, patch: Partial<ProfileForm>): ProfileDraft {
  const form = { ...draft.form, ...patch };
  return {
    ...draft,
    form,
    clashes: draft.clashes.filter((field) => !same(field, draft.start, form)),
  };
}

/** Why the form can't be saved, in the shared profile rules' words, or null when it can. */
export function profileProblem(form: ProfileForm): string | null {
  const parsed = teammateProfileSchema.safeParse(form);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the profile.");
}

/** What `teammates.update` takes: the whole profile, as the server trims it, and its revision. */
export function profileUpdate(teammateId: string, draft: ProfileDraft) {
  return {
    teammateId,
    profile: { ...draft.form, name: draft.form.name.trim(), role: draft.form.role.trim() },
    revision: draft.revision,
  };
}

/** "Name and job", in the editor's words. */
function listFields(fields: readonly ProfileField[]): string {
  const labels = fields.map((field) => FIELD_LABELS[field]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** What the editor says about clashing fields: saving replaces what was written elsewhere. */
export function clashText(name: string, clashes: readonly ProfileField[]): string | null {
  if (clashes.length === 0) return null;
  const fields = listFields(clashes);
  const capital = fields.charAt(0).toUpperCase() + fields.slice(1);
  return `${capital} also changed elsewhere while you were editing ${name}. Saving replaces ${clashes.length === 1 ? "that change" : "those changes"} with yours.`;
}

/**
 * What the editor says after a save was refused because the profile changed meanwhile and the
 * form has followed it: what you changed is still here, on top of what's there now.
 */
export const REBASED_TEXT =
  "This profile changed elsewhere since you opened it. Your changes are still here, on top of the latest version. Look them over and save again.";

/** The confirmation before archiving a teammate: what stops, what stays, and the lead. */
export function archiveText(teammate: Pick<TeammateSummary, "name" | "isLead">): string {
  const { name } = teammate;
  const lead = teammate.isLead
    ? ` ${name} is the lead, so nobody will lead until you choose another teammate: group messages that don't mention anyone go to the chat's first member.`
    : "";
  return `${name} stops what they're doing, their automations turn off, and their chats are archived. Their workspace stays on the computer.${lead}`;
}

/**
 * After a duplicate got no answer: the copy it may have made, found as a teammate named as asked
 * who wasn't on the team before, so trying again doesn't make a second one. Null if there's none.
 */
export function madeCopy(
  before: readonly Pick<TeammateSummary, "id">[],
  after: readonly Pick<TeammateSummary, "id" | "name">[],
  name: string,
): string | null {
  const known = new Set(before.map((teammate) => teammate.id));
  const wanted = name.trim().toLowerCase();
  return (
    after.find((teammate) => !known.has(teammate.id) && teammate.name.toLowerCase() === wanted)
      ?.id ?? null
  );
}

/** What making a teammate the lead changes, said before it does. */
export function leadText(
  teammate: Pick<TeammateSummary, "name">,
  lead: Pick<TeammateSummary, "name"> | undefined,
): string {
  const instead = lead ? `, instead of ${lead.name}` : "";
  return `${teammate.name} will answer group messages that don't mention anyone, and hand work to others${instead}.`;
}
