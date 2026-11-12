import { describe, expect, it } from "vitest";
import { notionEffect, notionId, notionParent } from "./effects";

describe("Notion ids and parents", () => {
  const id = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6";

  it("reads ids from bare ids, dashed ids and URLs", () => {
    expect(notionId(id)).toBe(id);
    expect(notionId("1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6")).toBe(id);
    expect(notionId(`https://www.notion.so/acme/Teammates-${id}`)).toBe(id);
    expect(notionId("not an id")).toBeNull();
  });

  it("reads each kind of parent, and calls anything else unknown", () => {
    expect(notionParent(undefined)).toBeNull();
    expect(notionParent("memory")).toEqual({ kind: "memory", id: null });
    expect(notionParent({ page_id: id })).toEqual({ kind: "page", id });
    expect(notionParent({ data_source_id: id })).toEqual({ kind: "data_source", id });
    expect(notionParent({ teamspace_id: id })).toEqual({ kind: "teamspace", id });
    expect(notionParent({ page_id: "nope" })).toBe("unknown");
    expect(notionParent({ workspace: true })).toBe("unknown");
    expect(notionParent(42)).toBe("unknown");
  });
});

describe("what a Notion write does", () => {
  const ours = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const theirs = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const isOurs = (value: string) => value === ours;

  it("lets teammates write freely in their own pages and area", () => {
    expect(notionEffect("create_pages", { parent: { page_id: ours } }, isOurs)).toBe("write");
    expect(notionEffect("update_page", { page_id: ours }, isOurs)).toBe("write");
    expect(notionEffect("update_database", { data_source_id: ours }, isOurs)).toBe("write");
  });

  it("treats a page with no parent as private", () => {
    expect(notionEffect("create_pages", {}, isOurs)).toBe("private_write");
  });

  it("asks about pages others can see, and anything it can't place", () => {
    expect(notionEffect("create_pages", { parent: { page_id: theirs } }, isOurs)).toBe("outward");
    expect(notionEffect("create_pages", { parent: { teamspace_id: ours } }, isOurs)).toBe(
      "outward",
    );
    expect(notionEffect("create_pages", { parent: { surprise: ours } }, isOurs)).toBe("outward");
    expect(notionEffect("update_page", { page_id: theirs }, isOurs)).toBe("outward");
    expect(notionEffect("update_page", {}, isOurs)).toBe("outward");
  });

  it("always asks about moves, duplicates and comments", () => {
    for (const tool of ["move_pages", "duplicate_page", "add_comment"])
      expect(notionEffect(tool, { page_id: ours }, isOurs)).toBe("outward");
  });
});
