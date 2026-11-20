import { describe, expect, it } from "vitest";
import { teammateProfileSchema } from "./management";
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

  it("accepts only a teammate the profile form could save", () => {
    const profile = { ...minimal.teammate, instructions: "", color: "#123456", autonomy: "full" };
    for (const emoji of ["🦊", "👩🏽‍💻", "x".repeat(8)])
      expect(
        teammateBundleSchema.safeParse({ ...minimal, teammate: { ...profile, emoji } }).success,
      ).toBe(teammateProfileSchema.safeParse({ ...profile, emoji }).success);
    // Longer than the form allows, so it couldn't be edited after an import.
    const long = { ...minimal, teammate: { ...profile, emoji: "x".repeat(9) } };
    expect(teammateBundleSchema.safeParse(long).success).toBe(false);
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
