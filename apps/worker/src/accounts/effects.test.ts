import type { ActionEffect } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import { approvalFor, calendarEffect, notionEffect, notionId, notionParent } from "./effects";

const ask = (
  effect: ActionEffect,
  autonomy: string,
  options: Partial<{
    askBeforeActing: boolean;
    readOutsideData: boolean;
    coveredByRule: boolean;
  }> = {},
) =>
  approvalFor({
    effect,
    autonomy,
    askBeforeActing: options.askBeforeActing ?? true,
    readOutsideData: options.readOutsideData ?? false,
    coveredByRule: options.coveredByRule ?? false,
  });

describe("whether an account action asks you", () => {
  it("never asks about reads", () => {
    for (const autonomy of ["full", "risky", "everything"])
      expect(ask("read", autonomy)).toBeNull();
  });

  it("asks about private writes only when the teammate asks about everything", () => {
    expect(ask("private_write", "full")).toBeNull();
    expect(ask("private_write", "risky")).toBeNull();
    expect(ask("private_write", "everything")).toBe("account_write");
  });

  it("follows autonomy and Always allow for writes", () => {
    expect(ask("write", "full")).toBeNull();
    expect(ask("write", "risky")).toBe("account_write");
    expect(ask("write", "risky", { coveredByRule: true })).toBeNull();
    // A teammate that asks about everything asks, rule or not.
    expect(ask("write", "everything", { coveredByRule: true })).toBe("account_write");
  });

  it("always asks before acting as you, unless you said not to and nothing outside could have steered it", () => {
    expect(ask("outward", "risky", { askBeforeActing: false })).toBe("account_outward");
    expect(ask("outward", "everything", { askBeforeActing: false })).toBe("account_outward");
    expect(ask("outward", "full")).toBe("account_outward");
    expect(ask("outward", "full", { askBeforeActing: false })).toBeNull();
    expect(ask("outward", "full", { askBeforeActing: false, readOutsideData: true })).toBe(
      "account_outward",
    );
    // Rules never cover acting as you.
    expect(ask("outward", "risky", { coveredByRule: true })).toBe("account_outward");
  });
});

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

describe("what a calendar change does", () => {
  const me = "me@example.com";

  it("is a write when only you are on the event", () => {
    expect(calendarEffect("create_event", { before: [], after: [] }, me)).toBe("write");
    expect(calendarEffect("update_event", { before: [me], after: ["ME@example.com"] }, me)).toBe(
      "write",
    );
  });

  it("acts as you when anyone else is, or was, on it", () => {
    expect(calendarEffect("create_event", { before: [], after: ["sam@example.com"] }, me)).toBe(
      "outward",
    );
    // Removing the last guest tells them too.
    expect(calendarEffect("update_event", { before: ["sam@example.com"], after: [] }, me)).toBe(
      "outward",
    );
  });

  it("always asks before deleting or answering", () => {
    expect(calendarEffect("delete_event", { before: [], after: [] }, me)).toBe("outward");
    expect(calendarEffect("respond", { before: [], after: [] }, me)).toBe("outward");
  });
});
