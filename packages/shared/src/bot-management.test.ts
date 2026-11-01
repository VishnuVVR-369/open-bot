import { describe, expect, it } from "vitest";
import { botCreation, botProfileSchema, createBotSchema, updateBotSchema } from "./bot-management";
import { TEAMMATE_TEMPLATES } from "./templates";

describe("bot management contracts", () => {
  it("requires a job and name for a custom teammate and defaults to cautious autonomy", () => {
    expect(() => botCreation({ name: "Researcher" })).toThrow();
    const { profile } = botCreation({ name: "Researcher", role: "research assistant" });
    expect(profile.autonomy).toBe("risky");
    expect(profile.instructions).toBe("");
  });
  it("uses a discovered template and applies explicit overrides", () => {
    const template = TEAMMATE_TEMPLATES[0]!;
    const result = botCreation({
      template_id: template.id,
      name: "Ada",
      starter_ids: [template.starters[0]!.id],
    });
    expect(result.profile.name).toBe("Ada");
    expect(result.profile.instructions).toBe(template.instructions);
    expect(result.schedules.map((schedule) => schedule.title)).toEqual([
      template.starters[0]!.title,
    ]);
    expect(botCreation({ template_id: template.id }).schedules).toEqual([]);
    expect(() => botCreation({ template_id: "made-up" })).toThrow();
    expect(() => botCreation({ template_id: template.id, starter_ids: ["made-up"] })).toThrow();
  });
  it("never introduces defaults into a partial edit", () => {
    expect(botProfileSchema.partial().parse({ name: "New name" })).toEqual({ name: "New name" });
    expect(
      updateBotSchema.safeParse({
        bot_id: crypto.randomUUID(),
        expected_revision: "revision",
        changes: {},
      }).success,
    ).toBe(false);
  });
  it("rejects permission fields that the profile tools do not manage", () => {
    expect(
      createBotSchema.safeParse({ name: "Ada", role: "researcher", monthlyBudgetCents: 50000 })
        .success,
    ).toBe(false);
    expect(
      updateBotSchema.safeParse({
        bot_id: crypto.randomUUID(),
        expected_revision: "revision",
        changes: { isPrimary: true },
      }).success,
    ).toBe(false);
  });
  it("adds a teammate's own skills and schedules to its template's, its own winning a name clash", () => {
    const template = TEAMMATE_TEMPLATES.find((entry) => entry.skills?.length)!;
    const clash = template.skills![0]!;
    const plan = botCreation({
      template_id: template.id,
      starter_ids: [template.starters[0]!.id],
      skills: [{ name: clash.name, description: "Mine", instructions: "My steps" }],
      schedules: [{ title: "Kickoff", prompt: "Say hello", at: "2099-01-01 09:00" }],
    });
    expect(plan.skills).toHaveLength(template.skills!.length);
    expect(plan.skills.find((skill) => skill.name === clash.name)!.description).toBe("Mine");
    expect(plan.schedules.map((schedule) => schedule.title)).toEqual([
      template.starters[0]!.title,
      "Kickoff",
    ]);
    expect(plan.schedules[1]).toMatchObject({ cron: null, at: "2099-01-01 09:00", quiet: false });
  });
  it("needs exactly one timing per schedule and a distinct name per skill", () => {
    const base = { name: "Ada", role: "researcher" };
    const schedule = { title: "Brief", prompt: "Brief me" };
    expect(createBotSchema.safeParse({ ...base, schedules: [schedule] }).success).toBe(false);
    expect(
      createBotSchema.safeParse({
        ...base,
        schedules: [{ ...schedule, cron: "0 9 * * *", at: "2099-01-01 09:00" }],
      }).success,
    ).toBe(false);
    const skill = { name: "brief", description: "Brief", instructions: "Steps" };
    expect(createBotSchema.safeParse({ ...base, skills: [skill, skill] }).success).toBe(false);
  });
  it("uses the color it is given when neither the request nor the template picks one", () => {
    expect(botCreation({ name: "Ada", role: "researcher" }, "#14B8A6").profile.color).toBe(
      "#14B8A6",
    );
  });
});
