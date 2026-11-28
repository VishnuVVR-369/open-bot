import { describe, expect, it } from "vitest";
import { configurationRevision, sameJson, teammateRevision } from "./configuration";

describe("sameJson", () => {
  // What Postgres gives back for {"name","path","mime","size"}: keys by length, then bytes.
  const sent = {
    name: "notes.txt",
    path: "/home/bot/shared/uploads/1-notes.txt",
    mime: "text/plain",
    size: 3,
  };
  const stored = {
    mime: "text/plain",
    name: "notes.txt",
    path: "/home/bot/shared/uploads/1-notes.txt",
    size: 3,
  };

  it("ignores object key order, as jsonb does", () => {
    expect(JSON.stringify([stored])).not.toBe(JSON.stringify([sent]));
    expect(sameJson([stored], [sent])).toBe(true);
    expect(
      sameJson({ a: { b: 1, c: [{ d: 1, e: 2 }] } }, { a: { c: [{ e: 2, d: 1 }], b: 1 } }),
    ).toBe(true);
  });

  it("still tells different values apart", () => {
    expect(sameJson([stored], [{ ...sent, size: 4 }])).toBe(false);
    expect(sameJson([stored], [{ ...sent, extra: "x" }])).toBe(false);
    expect(sameJson([stored, stored], [sent])).toBe(false);
    expect(sameJson(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameJson({ size: 3 }, { size: "3" })).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson(null, [])).toBe(false);
  });

  it("treats what a jsonb column can't keep the way saving it would", () => {
    // An undefined field isn't saved, and a Date is saved as its ISO string.
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    const at = new Date("2026-11-15T10:00:00.000Z");
    expect(sameJson({ at: at.toISOString() }, { at })).toBe(true);
  });

  it("agrees with the configuration revision", () => {
    expect(configurationRevision([stored])).toBe(configurationRevision([sent]));
  });
});

describe("teammateRevision", () => {
  const profile = {
    name: "Iris",
    role: "Writer",
    instructions: "Be brief.",
    color: "#7C5CFF",
    emoji: "",
    autonomy: "risky",
  };
  const row = {
    id: "0b6b7b0e-6a4f-4d3c-9c55-7d1f1e6b2a10",
    ...profile,
    isLead: false,
    monthlyBudgetCents: null,
    lessonsChangedAt: null,
    updatedAt: new Date("2026-11-28T10:00:00.000Z"),
  };

  it("covers the profile only, not the rest of the row", () => {
    const revision = teammateRevision(row);
    expect(teammateRevision(profile)).toBe(revision);
    const changed = {
      ...row,
      isLead: true,
      monthlyBudgetCents: 10_000,
      lessonsChangedAt: new Date(),
      updatedAt: new Date(),
    };
    expect(teammateRevision(changed)).toBe(revision);
  });

  it("changes with every profile field", () => {
    const revision = teammateRevision(profile);
    for (const [field, value] of Object.entries({
      name: "Rex",
      role: "Editor",
      instructions: "Be thorough.",
      color: "#2E9BFF",
      emoji: "🦊",
      autonomy: "full",
    }))
      expect(teammateRevision({ ...profile, [field]: value }), field).not.toBe(revision);
  });
});
