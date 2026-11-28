import type { PendingProposalView } from "@open-bot/api";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { afterConflict } from "./proposals";

const proposal = (id: string, instructionsNow = "Be brief."): PendingProposalView => ({
  id,
  teammateId: "t1",
  current: "",
  proposed: "Answer in bullets.",
  reason: "Shorter",
  createdAt: "2026-11-28T09:00:00Z",
  instructionsNow,
});

describe("a refused decision on suggested instructions", () => {
  it("shows the same suggestion again, against the instructions now, to review again", () => {
    expect(afterConflict("p1", { error: null, data: proposal("p1", "Edited on the web.") })).toBe(
      "review-again",
    );
  });

  it("settles it when it was decided elsewhere or replaced", () => {
    expect(afterConflict("p1", { error: null, data: null })).toBe("settled");
    expect(afterConflict("p1", { error: null, data: proposal("p2") })).toBe("settled");
  });

  it("settles it when the teammate is gone, as an archived one is", () => {
    const gone = new ORPCError("NOT_FOUND", { defined: true, message: "No such teammate." });
    expect(afterConflict("p1", { error: gone })).toBe("settled");
  });

  it("keeps the card when what's waiting couldn't be read", () => {
    expect(afterConflict("p1", { error: new TypeError("Network request failed") })).toBe(
      "review-again",
    );
  });
});
