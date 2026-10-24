import { describe, expect, it } from "vitest";
import { describeCron, nextCronRun } from "./schedule";
import { isNothingToReport, pickStarters, TEAMMATE_TEMPLATES } from "./templates";

describe("TEAMMATE_TEMPLATES", () => {
  it("has unique ids, and starters that run and read well", () => {
    const ids = TEAMMATE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEAMMATE_TEMPLATES) {
      const starterIds = template.starters.map((starter) => starter.id);
      expect(new Set(starterIds).size).toBe(starterIds.length);
      for (const starter of template.starters) {
        expect(nextCronRun(starter.cron, "UTC").getTime()).toBeGreaterThan(Date.now());
        // Shown in plain words, not as a cron expression.
        expect(describeCron(starter.cron)).not.toBe(starter.cron);
      }
    }
  });
});

it("pickStarters only returns starters of that template", () => {
  expect(pickStarters("researcher", ["morning-briefing"]).map((s) => s.title)).toEqual([
    "Morning briefing",
  ]);
  expect(pickStarters("researcher", ["plan-week"])).toEqual([]);
  expect(pickStarters(null, ["plan-week"])).toEqual([]);
  expect(pickStarters("nope", ["plan-week"])).toEqual([]);
});

describe("isNothingToReport", () => {
  it("recognizes a quiet routine's empty check-in", () => {
    expect(isNothingToReport("Nothing to report.")).toBe(true);
    expect(isNothingToReport("  **Nothing to report**  ")).toBe(true);
    expect(isNothingToReport("nothing to report!")).toBe(true);
  });

  it("doesn't hide real news", () => {
    expect(isNothingToReport("Nothing to report, except your passport expires in May.")).toBe(
      false,
    );
    expect(isNothingToReport("")).toBe(false);
    expect(isNothingToReport(null)).toBe(false);
  });
});

describe("starters", () => {
  it("give every template a quiet daily check-in and a weekly retro", () => {
    for (const template of TEAMMATE_TEMPLATES) {
      const ids = template.starters.map((starter) => starter.id);
      expect(ids, template.id).toContain("check-in");
      expect(ids, template.id).toContain("weekly-retro");
      expect(template.starters.find((starter) => starter.id === "check-in")?.quiet).toBe(true);
    }
  });
});
