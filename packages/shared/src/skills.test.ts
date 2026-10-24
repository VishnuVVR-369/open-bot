import { describe, expect, it } from "vitest";
import { invokedSkillNames, skillInputSchema, skillMarkdown, toSkillName } from "./skills";

describe("skills", () => {
  it("turns a title into a name you can type", () => {
    expect(toSkillName("Weekly Report!")).toBe("weekly-report");
    expect(toSkillName("  Café menu -- v2 ")).toBe("cafe-menu-v2");
  });

  it("finds the skills a message runs", () => {
    expect(invokedSkillNames("/weekly-report for last week")).toEqual(["weekly-report"]);
    expect(invokedSkillNames("please run /a1 and /b-2, then /a1.")).toEqual(["a1", "b-2"]);
    expect(invokedSkillNames("see https://x.com/path and a/b")).toEqual([]);
  });

  it("rejects names that aren't kebab-case", () => {
    const base = { description: "d", instructions: "i", botId: null };
    expect(skillInputSchema.safeParse({ ...base, name: "ok-name" }).success).toBe(true);
    expect(skillInputSchema.safeParse({ ...base, name: "Bad Name" }).success).toBe(false);
    expect(skillInputSchema.safeParse({ ...base, name: "trailing-" }).success).toBe(false);
  });

  it("writes a SKILL.md whose description survives any characters", () => {
    const md = skillMarkdown({
      name: "x",
      description: 'Use when: "quotes" and\nnew lines',
      instructions: "Do it.",
    });
    expect(md).toContain('description: "Use when: \\"quotes\\" and\\nnew lines"');
    expect(md.endsWith("Do it.\n")).toBe(true);
  });
});
