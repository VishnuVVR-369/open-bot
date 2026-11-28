import { describe, expect, it } from "vitest";
import {
  archiveText,
  changedFields,
  clashText,
  editProfile,
  leadText,
  madeCopy,
  profileChanged,
  profileDraft,
  profileProblem,
  profileUpdate,
  rebaseProfile,
  takeTheirs,
  type ProfileForm,
} from "./profile";

const PROFILE: ProfileForm = {
  name: "Iris",
  role: "Writer",
  instructions: "Be brief.",
  color: "#7C5CFF",
  emoji: "",
  autonomy: "risky",
};
const view = (profile: Partial<ProfileForm> = {}, revision = "r1") => ({
  profile: { ...PROFILE, ...profile },
  revision,
});

describe("a teammate's profile form", () => {
  it("starts unchanged, and spaces around the name and job aren't a change", () => {
    const draft = profileDraft(view());
    expect(profileChanged(draft)).toBe(false);
    expect(changedFields(editProfile(draft, { name: " Iris ", role: "Writer  " }))).toEqual([]);
    expect(changedFields(editProfile(draft, { instructions: "Be brief. " }))).toEqual([
      "instructions",
    ]);
    expect(changedFields(editProfile(draft, { color: "#2E9BFF", autonomy: "full" }))).toEqual([
      "color",
      "autonomy",
    ]);
  });

  it("sends the whole profile, trimmed, with the revision it started from", () => {
    const draft = editProfile(profileDraft(view({}, "r7")), { name: "  Nova ", role: " Editor" });
    expect(profileUpdate("t1", draft)).toEqual({
      teammateId: "t1",
      profile: { ...PROFILE, name: "Nova", role: "Editor" },
      revision: "r7",
    });
  });

  it("says what's wrong in the shared rules' words", () => {
    expect(profileProblem(PROFILE)).toBeNull();
    expect(profileProblem({ ...PROFILE, name: "  " })).toBe("Give your teammate a name.");
    expect(profileProblem({ ...PROFILE, role: "" })).toBe("Describe their job in a few words.");
    expect(profileProblem({ ...PROFILE, name: "x".repeat(41) })).toBe(
      "Keep the name under 40 characters.",
    );
    expect(profileProblem({ ...PROFILE, role: "x".repeat(81) })).toBe(
      "Keep the job under 80 characters.",
    );
    expect(profileProblem({ ...PROFILE, instructions: "x".repeat(20_001) })).toBe(
      "Keep the instructions under 20,000 characters.",
    );
  });
});

describe("following the profile as it changes elsewhere", () => {
  it("does nothing for the same revision", () => {
    const draft = editProfile(profileDraft(view()), { name: "Nova" });
    expect(rebaseProfile(draft, view({ name: "Other" }))).toBe(draft);
  });

  it("follows what you haven't touched and keeps what you changed", () => {
    const draft = editProfile(profileDraft(view()), { role: "Editor" });
    const rebased = rebaseProfile(
      draft,
      view({ instructions: "Cite sources.", emoji: "🦊" }, "r2"),
    );
    expect(rebased).toEqual({
      start: { ...PROFILE, instructions: "Cite sources.", emoji: "🦊" },
      revision: "r2",
      form: { ...PROFILE, instructions: "Cite sources.", emoji: "🦊", role: "Editor" },
      clashes: [],
    });
    // What it saves keeps the change from elsewhere, so nothing is overwritten.
    expect(profileUpdate("t1", rebased).profile.instructions).toBe("Cite sources.");
  });

  it("marks a field you changed that was changed there too, until you give it up", () => {
    const draft = editProfile(profileDraft(view()), { instructions: "Mine.", name: "Nova" });
    const rebased = rebaseProfile(draft, view({ instructions: "Theirs." }, "r2"));
    expect(rebased.form.instructions).toBe("Mine.");
    expect(rebased.clashes).toEqual(["instructions"]);
    expect(clashText(rebased)).toBe(
      "The responsibilities were also changed elsewhere while you were editing. Saving replaces them with yours.",
    );
    const given = takeTheirs(rebased, "instructions");
    expect(given.form.instructions).toBe("Theirs.");
    expect(given.clashes).toEqual([]);
    expect(changedFields(given)).toEqual(["name"]);
  });

  it("keeps a clash through later refreshes, and drops it once the field matches", () => {
    const draft = editProfile(profileDraft(view()), { role: "Editor" });
    const once = rebaseProfile(draft, view({ role: "Analyst" }, "r2"));
    expect(once.clashes).toEqual(["role"]);
    // Something else changes there: the clash on the job stays.
    const twice = rebaseProfile(once, view({ role: "Analyst", emoji: "🐙" }, "r3"));
    expect(twice.clashes).toEqual(["role"]);
    expect(twice.form).toMatchObject({ role: "Editor", emoji: "🐙" });
    // Changed back to what's saved there: no clash, and nothing to save.
    expect(editProfile(twice, { role: "Analyst" }).clashes).toEqual([]);
    // Or the same change was made there: nothing to replace.
    const agreed = rebaseProfile(once, view({ role: "Editor" }, "r4"));
    expect(agreed.clashes).toEqual([]);
    expect(profileChanged(agreed)).toBe(false);
  });

  it("says what a short field was changed to, and names several together", () => {
    const start = { ...PROFILE, role: "Analyst", autonomy: "full" as const };
    expect(clashText({ start, clashes: [] })).toBeNull();
    expect(clashText({ start, clashes: ["role"] })).toBe(
      "The job was also changed elsewhere, to “Analyst”, while you were editing. Saving replaces it with yours.",
    );
    expect(clashText({ start, clashes: ["autonomy"] })).toBe(
      "The setting for when they ask you first was also changed elsewhere, to Works on its own, while you were editing. Saving replaces it with yours.",
    );
    expect(clashText({ start, clashes: ["name", "role", "instructions"] })).toBe(
      "The name, job and responsibilities were also changed elsewhere while you were editing. Saving replaces them with yours.",
    );
  });
});

describe("archiving a teammate", () => {
  it("says what stops and what stays", () => {
    expect(archiveText({ name: "Iris", isLead: false })).toBe(
      "Iris stops what they're doing, their automations turn off, and their chats are archived. Their workspace stays on the computer.",
    );
  });

  it("says nobody leads after the lead is archived", () => {
    expect(archiveText({ name: "Iris", isLead: true })).toContain(
      "Iris is the lead, so nobody will lead until you choose another teammate",
    );
  });
});

describe("a duplicate whose answer was lost", () => {
  const before = [{ id: "iris" }, { id: "old-copy" }];
  it("is found as a new teammate with the name asked for", () => {
    const after = [
      { id: "iris", name: "Iris" },
      { id: "old-copy", name: "Iris 2" },
      { id: "new", name: "Iris 2" },
    ];
    expect(madeCopy(before, after, " iris 2 ")).toBe("new");
  });

  it("isn't found when nobody new has that name", () => {
    expect(
      madeCopy(
        before,
        [
          { id: "iris", name: "Iris" },
          { id: "old-copy", name: "Iris 2" },
        ],
        "Iris 2",
      ),
    ).toBeNull();
    expect(madeCopy(before, [{ id: "other", name: "Kit" }], "Iris 2")).toBeNull();
  });
});

describe("making a teammate the lead", () => {
  it("says who answers group messages from now on, and instead of whom", () => {
    expect(leadText({ name: "Kit" }, { name: "Iris" })).toBe(
      "Kit will answer group messages that don't mention anyone, and hand work to others, instead of Iris.",
    );
    expect(leadText({ name: "Kit" }, undefined)).toBe(
      "Kit will answer group messages that don't mention anyone, and hand work to others.",
    );
  });
});
