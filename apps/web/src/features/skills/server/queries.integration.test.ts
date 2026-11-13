import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { skills } from "@open-bot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = testDatabaseServer();

describe.skipIf(!url)("the skills read", () => {
  const database = testDatabase(url);
  let listSkills: typeof import("./queries").listSkills;

  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    ({ listSkills } = await import("./queries"));
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/server/db");
    await pool.end();
    await database.drop();
  });

  it("lists every skill by name, with its instructions", async () => {
    const skill = (name: string) => ({
      name,
      description: `How to ${name}`,
      instructions: `Steps to ${name}`,
      createdBy: "user" as const,
    });
    await database.db.insert(skills).values([skill("triage"), skill("plan"), skill("summarize")]);

    const list = await listSkills();

    expect(list.map((entry) => entry.name)).toEqual(["plan", "summarize", "triage"]);
    expect(list[0]).toMatchObject({
      description: "How to plan",
      instructions: "Steps to plan",
      createdBy: "user",
    });
    expect(list.every((entry) => typeof entry.updatedAt === "string")).toBe(true);
  });
});
