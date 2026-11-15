import { type HandoffItem } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import { handoffName } from "./handoff";

const item = { kind: "handoff", id: "h1", message: "Over to you" } as unknown as HandoffItem;

describe("handoffName", () => {
  it("reads the teammate a handoff names", () => {
    expect(handoffName({ ...item, toTeammateId: "t1", toTeammateName: "Ada" })).toBe("Ada");
  });

  it("reads a handoff from a server before the database rename", () => {
    const older = { ...item, toBotId: "t1", toBotName: "Ada" } as unknown as HandoffItem; // vocabulary: allow
    expect(handoffName(older)).toBe("Ada");
  });
});
