import { describe, expect, it } from "vitest";
import { instructionsChange } from "../teammates/proposals";
import {
  forgetMemoryQuestion,
  memoryExpired,
  memorySourceLabel,
  memoryTextProblem,
} from "./display";
import type { MemorySource } from "./memory";

const item = (type: MemorySource["type"], state: "active" | "candidate" = "active") => ({
  state,
  source: { type },
});

describe("memorySourceLabel", () => {
  it("says you saved it, or it came from feedback or an import", () => {
    expect(memorySourceLabel(item("user"), null)).toBe("Saved by you");
    expect(memorySourceLabel(item("feedback"), "Ada")).toBe("From your feedback");
    expect(memorySourceLabel(item("import"), null)).toBe("Imported");
  });

  it("names the teammate that saved or suggested it", () => {
    expect(memorySourceLabel(item("teammate"), "Ada")).toBe("Saved by Ada");
    expect(memorySourceLabel(item("teammate", "candidate"), "Ada")).toBe("Suggested by Ada");
    expect(memorySourceLabel(item("extraction"), "Ada")).toBe("Suggested by Ada");
  });

  it("falls back to plain words when the teammate isn't known", () => {
    expect(memorySourceLabel(item("teammate"), null)).toBe("Saved by a teammate");
    expect(memorySourceLabel(item("extraction"), null)).toBe("Suggested from a conversation");
  });
});

describe("memoryExpired", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  it("is expired once the time has passed, and never without an expiry", () => {
    expect(memoryExpired({ expiresAt: null }, now)).toBe(false);
    expect(memoryExpired({ expiresAt: "2026-11-27T12:00:00Z" }, now)).toBe(true);
    expect(memoryExpired({ expiresAt: "2026-11-28T00:00:00Z" }, now)).toBe(false);
  });
});

describe("forgetMemoryQuestion", () => {
  it("asks to forget a memory, or to dismiss a suggestion", () => {
    expect(forgetMemoryQuestion({ state: "active" })).toMatchObject({
      title: "Forget this memory?",
      action: "Forget memory",
    });
    expect(forgetMemoryQuestion({ state: "candidate" })).toMatchObject({
      title: "Dismiss this suggestion?",
      action: "Dismiss suggestion",
    });
  });
});

describe("memoryTextProblem", () => {
  it("refuses what the server would, in plain words", () => {
    expect(memoryTextProblem("  hi ")).toBe("Write at least a few characters.");
    expect(memoryTextProblem("x".repeat(8001))).toBe("Keep it under 8,000 characters.");
    expect(memoryTextProblem("Lives in Berlin", "k".repeat(121))).toBe(
      "Keep the topic key under 120 characters.",
    );
    expect(memoryTextProblem("Lives in Berlin", "home.city")).toBeNull();
  });
});

describe("instructionsChange", () => {
  it("shows the suggestion against the instructions as they are now", () => {
    const change = instructionsChange(
      { current: "Be brief.", proposed: "Be brief.\nCite sources." },
      "Be brief.",
    );
    expect(change.editedSince).toBe(false);
    expect(change.lines).toEqual([
      { type: "same", text: "Be brief." },
      { type: "added", text: "Cite sources." },
    ]);
  });

  it("says when the instructions changed since the suggestion", () => {
    const change = instructionsChange(
      { current: "Be brief.", proposed: "Be brief.\nCite sources." },
      "Be thorough.",
    );
    expect(change.editedSince).toBe(true);
    expect(change.lines).toContainEqual({ type: "removed", text: "Be thorough." });
  });
});
