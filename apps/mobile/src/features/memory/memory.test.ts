import type { MemoryItem } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import {
  changedSince,
  createOutcome,
  expiryLabel,
  followMemory,
  memoryCount,
  memoryDraft,
  memoryHref,
  memoryInput,
  memoryListHref,
  memoryMeta,
  memoryFormProblem,
  memoryScopes,
  newMemoryHref,
  revisionSource,
  runMemoryText,
  saveNote,
  scopeTeammate,
  SHARED_SCOPE,
} from "./memory";

const memory = (patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "m1",
  teammateId: "t1",
  kind: "fact",
  content: "Lives in Berlin",
  key: null,
  revision: 1,
  state: "active",
  pinned: false,
  expiresAt: null,
  source: { type: "user" },
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:00Z",
  ...patch,
});

describe("where memory lives", () => {
  it("links the shared list, a teammate's, a memory, and a new one", () => {
    expect(memoryListHref()).toBe("/memory");
    expect(memoryListHref("t1")).toBe("/memory?teammateId=t1");
    expect(memoryHref("m1")).toBe("/memory/m1");
    expect(memoryHref("m1", "unchanged")).toBe("/memory/m1?saved=unchanged");
    expect(newMemoryHref(null)).toBe("/memory/new");
    expect(newMemoryHref("t1")).toBe("/memory/new?teammateId=t1");
  });

  it("offers shared memory first, then each teammate's", () => {
    const scopes = memoryScopes([
      { id: "t1", name: "Ada" },
      { id: "t2", name: "Linus" },
    ]);
    expect(scopes.map((scope) => scope.label)).toEqual(["Shared", "Ada", "Linus"]);
    expect(scopeTeammate(SHARED_SCOPE)).toBeNull();
    expect(scopeTeammate("t2")).toBe("t2");
  });
});

describe("the memory form", () => {
  it("sends what's written, trimmed, for the memory's own scope", () => {
    const draft = memoryDraft(memory({ key: "home.city", pinned: true }));
    expect(memoryInput({ ...draft.form, content: "  Lives in Bonn \n" }, "t1")).toEqual({
      teammateId: "t1",
      content: "Lives in Bonn",
      kind: "fact",
      pinned: true,
      key: "home.city",
      expiresAt: null,
    });
  });

  it("starts a new memory empty, and refuses one too short to save", () => {
    const draft = memoryDraft(null);
    expect(draft.base).toBeNull();
    expect(memoryFormProblem(draft.form)).toBe("Write at least a few characters.");
    expect(memoryFormProblem({ ...draft.form, content: "Likes tea" })).toBeNull();
  });
});

describe("following a memory that changed elsewhere", () => {
  it("follows the fresh copy while the form is untouched", () => {
    const draft = memoryDraft(memory());
    const fresh = memory({ revision: 2, content: "Lives in Hamburg" });
    const followed = followMemory(draft, fresh);
    expect(followed.base).toBe(fresh);
    expect(followed.form.content).toBe("Lives in Hamburg");
    expect(changedSince(followed, fresh)).toBe(false);
  });

  it("keeps your changes and the revision you started from, so saving them is refused", () => {
    const draft = memoryDraft(memory());
    const edited = { ...draft, form: { ...draft.form, content: "Lives in Bonn" } };
    const fresh = memory({ revision: 2, content: "Lives in Hamburg" });
    const kept = followMemory(edited, fresh);
    expect(kept).toBe(edited);
    expect(kept.base?.revision).toBe(1);
    expect(changedSince(kept, fresh)).toBe(true);
  });

  it("follows a suggestion confirmed elsewhere, and leaves a new memory alone", () => {
    const draft = memoryDraft(memory({ state: "candidate" }));
    expect(followMemory(draft, memory({ state: "active", revision: 2 })).base?.state).toBe(
      "active",
    );
    const blank = memoryDraft(null);
    expect(followMemory(blank, memory())).toBe(blank);
    expect(changedSince(blank, memory())).toBe(false);
  });

  it("doesn't call the same revision a change", () => {
    const draft = memoryDraft(memory());
    expect(followMemory(draft, memory())).toBe(draft);
    expect(changedSince(draft, memory())).toBe(false);
    expect(changedSince(draft, undefined)).toBe(false);
  });
});

describe("saving a new memory", () => {
  it("counts a resend after a lost answer as this save, not an old one", () => {
    expect(createOutcome("unchanged", true)).toBe("created");
    expect(createOutcome("unchanged", false)).toBe("unchanged");
    expect(createOutcome("confirmed", true)).toBe("confirmed");
  });

  it("says when nothing new was added", () => {
    expect(saveNote("unchanged")).toMatch(/already saved/);
    expect(saveNote("confirmed")).toMatch(/suggested/);
    expect(saveNote("created")).toBeNull();
    expect(saveNote(undefined)).toBeNull();
  });
});

describe("how a memory is shown", () => {
  const now = new Date("2026-11-27T12:00:00Z");

  it("says its type, who saved it, and how it stands", () => {
    expect(
      memoryMeta(
        memory({
          source: { type: "teammate" },
          pinned: true,
          revision: 3,
          expiresAt: "2026-12-03T09:00:00Z",
        }),
        "Ada",
        now,
      ),
    ).toEqual(["Fact", "Saved by Ada", "Pinned", "Expires 3 Dec", "Revision 3"]);
    expect(memoryMeta(memory(), null, now)).toEqual(["Fact", "Saved by you"]);
  });

  it("says an expiry that has passed", () => {
    expect(expiryLabel("2026-11-20T09:00:00Z", now)).toBe("Expired 20 Nov");
  });

  it("says who made a revision", () => {
    expect(revisionSource({ source: { type: "user" } })).toBe("By you");
    expect(revisionSource({ source: { type: "extraction" } })).toBe("From a conversation");
  });

  it("counts a list, saying when it stops at the limit", () => {
    expect(memoryCount(0, 200)).toBe("Nothing saved yet");
    expect(memoryCount(1, 200)).toBe("1 memory");
    expect(memoryCount(12, 200)).toBe("12 memories");
    expect(memoryCount(200, 200)).toBe("The newest 200 memories");
  });
});

describe("what a reply was given", () => {
  const ref = {
    id: "m1",
    revision: 2,
    content: "Lives in Berlin",
    changed: false,
    forgotten: false,
  };
  it("shows the memory as the reply saw it, or why it can't", () => {
    expect(runMemoryText(ref)).toEqual({ text: "Lives in Berlin", faded: false });
    expect(runMemoryText({ ...ref, content: null, changed: true })).toEqual({
      text: "Memory changed since this reply",
      faded: true,
    });
    expect(runMemoryText({ ...ref, content: null, forgotten: true, changed: true })).toEqual({
      text: "Forgotten memory",
      faded: true,
    });
  });
});
