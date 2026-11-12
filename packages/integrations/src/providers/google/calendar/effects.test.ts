import { describe, expect, it } from "vitest";
import { calendarEffect } from "./effects";

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
