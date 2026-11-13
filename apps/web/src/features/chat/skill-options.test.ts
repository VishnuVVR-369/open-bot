import { BUILT_IN_SKILLS } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@/lib/types";
import { skillOptions, skillQueryAt } from "./skill-options";

const skill = (name: string, teammateId: string | null): SkillSummary =>
  ({ id: name, name, description: `${name} skill`, botId: teammateId }) as SkillSummary;

describe("skillQueryAt", () => {
  it("reads the name after a slash that ends at the caret", () => {
    expect(skillQueryAt("/", 1)).toBe("");
    expect(skillQueryAt("/rep", 4)).toBe("rep");
    expect(skillQueryAt("please /rep", 11)).toBe("rep");
    expect(skillQueryAt("please /report now", 14)).toBe("report");
  });

  it("is null without a slash starting a word at the caret", () => {
    expect(skillQueryAt("", 0)).toBeNull();
    expect(skillQueryAt("and/or", 6)).toBeNull();
    expect(skillQueryAt("/report now", 11)).toBeNull();
    expect(skillQueryAt("/Report", 7)).toBeNull();
  });
});

describe("skillOptions", () => {
  const members = [{ id: "sol" }];
  const saved = [
    skill("weekly-report", null),
    skill("sol-notes", "sol"),
    skill("ana-notes", "ana"),
  ];

  it("offers built-in skills, shared ones and the chat's teammates' own", () => {
    const names = skillOptions("", members, saved).map((option) => option.name);
    expect(names).toContain("weekly-report");
    expect(names).toContain("sol-notes");
    expect(names).not.toContain("ana-notes");
    expect(skillOptions("", [], []).length).toBe(Math.min(8, BUILT_IN_SKILLS.length));
  });

  it("matches anywhere in the name, puts names that start with the query first, and keeps eight", () => {
    const options = skillOptions(
      "notes",
      [{ id: "sol" }, { id: "ana" }],
      [skill("sol-notes", "sol"), skill("notes-daily", null)],
    );
    expect(options.map((option) => option.name)).toEqual(["notes-daily", "sol-notes"]);
    const many = Array.from({ length: 12 }, (_, n) => skill(`report-${n}`, null));
    expect(skillOptions("report", [], many)).toHaveLength(8);
  });

  it("marks the built-in ones", () => {
    const [first] = BUILT_IN_SKILLS;
    if (!first) return;
    const option = skillOptions(first.name, [], []).find((entry) => entry.name === first.name);
    expect(option).toMatchObject({ id: `built-in:${first.name}`, botId: null, builtIn: true });
  });
});
