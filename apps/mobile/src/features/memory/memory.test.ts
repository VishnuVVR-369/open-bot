import type { MemoryItem } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import {
  afterReload,
  changedSince,
  expiryLabel,
  followMemory,
  historyScreenState,
  leaveQuestion,
  memoryCount,
  memoryCreate,
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
  sameMemoryScope,
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
  const form = { ...memoryDraft(null).form, content: "Lives in Berlin" };

  it("sends a lost save again exactly, with its id, and a new save with a fresh id", () => {
    let n = 0;
    const newId = () => `id-${++n}`;
    const first = memoryCreate(null, form, "t1", newId);
    expect(first).toEqual({ input: memoryInput(form, "t1"), id: "id-1" });
    // Edits after a lost answer can't happen (the form is frozen), but even so the resend is the
    // one that may have been saved, under the same id.
    expect(memoryCreate(first, { ...form, content: "Lives in Paris" }, "t1", newId)).toBe(first);
    expect(memoryCreate(null, form, "t1", newId).id).toBe("id-2");
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

describe("reloading after a conflict", () => {
  const opened = memory();
  const edited = {
    ...memoryDraft(opened),
    form: { ...memoryDraft(opened).form, content: "Lives in Paris" },
  };

  it("replaces your changes only with a fresh read", () => {
    const fresh = memory({ revision: 2, content: "Lives in Rome" });
    expect(afterReload(edited, { ok: true, item: fresh })).toEqual({
      draft: memoryDraft(fresh),
      refused: false,
      problem: null,
    });
  });

  it("keeps your changes and the conflict when the read failed", () => {
    const next = afterReload(edited, { ok: false, message: "Couldn't reach open-bot." });
    expect(next.draft).toBe(edited);
    expect(next.draft.form.content).toBe("Lives in Paris");
    expect(next.refused).toBe(true);
    expect(next.problem).toBe("Couldn't reach open-bot.");
  });
});

describe("leaving the editor", () => {
  it("asks while what you wrote isn't saved, even once the memory was forgotten", () => {
    expect(leaveQuestion(false, false, false)).toBeNull();
    expect(leaveQuestion(true, true, false)).toBeNull();
    expect(leaveQuestion(true, false, false)?.title).toBe("Discard your changes?");
    expect(leaveQuestion(true, false, true)?.body).toMatch(/Copy it first/);
  });
});

describe("the memory list", () => {
  it("keeps results on screen only for another search in the same scope", () => {
    const shared = ["memory", "list", null, "berlin"] as const;
    const ada = ["memory", "list", "t1", ""] as const;
    expect(sameMemoryScope(shared, null)).toBe(true);
    expect(sameMemoryScope(shared, "t1")).toBe(false);
    expect(sameMemoryScope(ada, "t1")).toBe(true);
    expect(sameMemoryScope(ada, null)).toBe(false);
    expect(sameMemoryScope(["memory", "get", "t1"], "t1")).toBe(false);
  });
});

describe("a memory's history", () => {
  const read = <T>(data: T | undefined, error: unknown = null) => ({
    data,
    error,
    isLoading: data === undefined && error === null,
  });
  const gone = { code: "NOT_FOUND" };
  const offline = new TypeError("Network request failed");
  const isGone = (error: unknown) => error === gone;
  const revisions = [{ revision: 1 }];

  it("hides cached revisions, and so Restore, once the server says it's gone", () => {
    expect(historyScreenState(read(memory(), gone), read(revisions), isGone)).toEqual({
      kind: "gone",
    });
    expect(historyScreenState(read(memory()), read(revisions, gone), isGone)).toEqual({
      kind: "gone",
    });
  });

  it("keeps what it read before through a failure that may pass", () => {
    expect(historyScreenState(read(memory(), offline), read(revisions), isGone)).toEqual({
      kind: "ready",
      current: memory(),
      revisions,
    });
    expect(historyScreenState(read(undefined, offline), read(revisions), isGone)).toEqual({
      kind: "error",
      error: offline,
    });
    expect(historyScreenState(read(undefined), read(revisions), isGone)).toEqual({
      kind: "loading",
    });
  });
});
