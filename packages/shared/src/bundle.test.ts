import { describe, expect, it } from "vitest";
import { BUNDLE_FORMAT, BUNDLE_VERSION, teammateBundleSchema } from "./bundle";

const minimal = {
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  teammate: { name: "Iris", role: "research assistant" },
};

describe("teammateBundleSchema", () => {
  it("fills in defaults for a minimal file", () => {
    const bundle = teammateBundleSchema.parse(minimal);
    expect(bundle.teammate.autonomy).toBe("risky");
    expect(bundle.skills).toEqual([]);
    expect(bundle.lessons).toEqual([]);
  });

  it("explains files it can't read", () => {
    const wrongFormat = teammateBundleSchema.safeParse({ ...minimal, format: "other" });
    expect(wrongFormat.error?.issues[0]?.message).toBe("This isn't an open-bot teammate file.");
    const newer = teammateBundleSchema.safeParse({ ...minimal, version: 2 });
    expect(newer.error?.issues[0]?.message).toMatch(/newer open-bot/);
  });

  it("refuses bad parts", () => {
    expect(
      teammateBundleSchema.safeParse({
        ...minimal,
        skills: [{ name: "Not A Name", description: "x", instructions: "y" }],
      }).success,
    ).toBe(false);
    expect(
      teammateBundleSchema.safeParse({
        ...minimal,
        watches: [{ title: "t", prompt: "p", url: "https://x.y", intervalMinutes: 1 }],
      }).success,
    ).toBe(false);
  });
});
