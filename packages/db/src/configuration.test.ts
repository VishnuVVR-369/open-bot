import { describe, expect, it } from "vitest";
import { configurationRevision, sameJson } from "./configuration";

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
