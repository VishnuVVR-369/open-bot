import { describe, expect, it } from "vitest";
import { agentsMarkdown } from "./instructions";

const bot = {
  name: "Rex",
  role: "software engineer",
  instructions: "",
  autonomy: "risky" as const,
};

describe("agentsMarkdown", () => {
  it("leaves out empty sections", () => {
    const text = agentsMarkdown(bot);
    expect(text).not.toContain("## About the user");
    expect(text).not.toContain("## Lessons");
    expect(text).not.toContain("## Your teammates");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("includes the profile and lessons, one per line", () => {
    const text = agentsMarkdown(bot, [], "I live in Berlin.", [
      "Use metric units.",
      "Keep replies\nshort.",
    ]);
    expect(text).toContain("## About the user");
    expect(text).toContain("I live in Berlin.");
    expect(text).toContain("## Lessons from the user's feedback");
    expect(text).toContain("- Use metric units.\n- Keep replies short.\n\n## Memory");
    expect(text.indexOf("## About the user")).toBeLessThan(text.indexOf("## Lessons"));
    expect(text).not.toMatch(/\n{3,}/);
  });
});

it("lists teammates to ask", () => {
  const text = agentsMarkdown(bot, [], "", [], [{ name: "Iris", role: "research assistant" }]);
  expect(text).toContain("## Your teammates");
  expect(text).toContain("- Iris, research assistant");
  expect(text).not.toMatch(/\n{3,}/);
});
