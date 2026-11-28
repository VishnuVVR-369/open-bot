import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { afterRefusal, cacheAfterSave, canSaveProfile, followProfile, saveRefusal } from "./editor";
import { editProfile, profileDraft, type ProfileForm } from "./profile";

const PROFILE: ProfileForm = {
  name: "Iris",
  role: "Writer",
  instructions: "Be brief.",
  color: "#7C5CFF",
  emoji: "",
  autonomy: "risky",
};
const view = (profile: Partial<ProfileForm> = {}, revision = "r1") => ({
  teammateId: "t1",
  profile: { ...PROFILE, ...profile },
  revision,
});
// As the API sends it: a contract's error is `defined`.
const gone = new ORPCError("NOT_FOUND", {
  status: 404,
  message: "That teammate is archived.",
  defined: true,
});
const changed = new ORPCError("STATE_CONFLICT", { status: 409, message: "It changed." });
const offline = new TypeError("Network request failed");

describe("the profile editor following the profile", () => {
  const draft = editProfile(profileDraft(view()), { role: "Editor" });

  it("holds still while a save is on its way, whose answer comes next", () => {
    expect(followProfile(draft, view({ emoji: "🦊" }, "r2"), true)).toBe(draft);
  });

  it("follows a fresher copy otherwise, keeping what you changed", () => {
    const followed = followProfile(draft, view({ emoji: "🦊" }, "r2"), false);
    expect(followed.revision).toBe("r2");
    expect(followed.form).toEqual({ ...PROFILE, emoji: "🦊", role: "Editor" });
  });
});

describe("a refused save", () => {
  it("is told apart: gone, changed meanwhile, or failed with words", () => {
    expect(saveRefusal(gone)).toEqual({ kind: "gone" });
    expect(saveRefusal(changed)).toEqual({ kind: "changed" });
    expect(
      saveRefusal(new ORPCError("BAD_REQUEST", { status: 400, message: "Pick one." })),
    ).toEqual({ kind: "failed", problem: "Pick one." });
    expect(saveRefusal(offline)).toMatchObject({ kind: "failed" });
  });

  const draft = editProfile(profileDraft(view()), { role: "Editor" });

  it("changed meanwhile, takes in the newer profile with your changes on top", () => {
    const next = afterRefusal(draft, { ok: true, view: view({ instructions: "Cite." }, "r2") });
    expect(next).toMatchObject({ rebased: true, gone: false, problem: null });
    expect(next.draft.form).toEqual({ ...PROFILE, instructions: "Cite.", role: "Editor" });
    expect(next.draft.revision).toBe("r2");
  });

  it("keeps the form as it was when the newer profile can't be read", () => {
    expect(afterRefusal(draft, { ok: false, error: gone })).toEqual({
      draft,
      rebased: false,
      gone: true,
      problem: null,
    });
    const failed = afterRefusal(draft, { ok: false, error: offline });
    expect(failed).toMatchObject({ draft, rebased: false, gone: false });
    expect(failed.problem).toEqual(expect.any(String));
  });
});

describe("Save", () => {
  const ready = { online: true, saving: false, changed: true, problem: null, gone: false };
  it("is on only online, with a fine change, not saving, and the teammate still there", () => {
    expect(canSaveProfile(ready)).toBe(true);
    expect(canSaveProfile({ ...ready, online: false })).toBe(false);
    expect(canSaveProfile({ ...ready, saving: true })).toBe(false);
    expect(canSaveProfile({ ...ready, changed: false })).toBe(false);
    expect(canSaveProfile({ ...ready, problem: "Pick a single emoji." })).toBe(false);
    expect(canSaveProfile({ ...ready, gone: true })).toBe(false);
  });
});

describe("the cached profile after a save", () => {
  const saved = view({ role: "Editor" }, "r2");
  it("becomes the saved one over the copy the save was based on, or none", () => {
    expect(cacheAfterSave(view(), "r1", saved)).toEqual({ write: saved });
    expect(cacheAfterSave(undefined, "r1", saved)).toEqual({ write: saved });
  });

  it("keeps a newer copy that came in meanwhile, and reads it again unless it's the save's", () => {
    expect(cacheAfterSave(view({ emoji: "🦊" }, "r3"), "r1", saved)).toEqual({
      keep: true,
      refetch: true,
    });
    expect(cacheAfterSave(saved, "r1", saved)).toEqual({ keep: true, refetch: false });
  });
});
