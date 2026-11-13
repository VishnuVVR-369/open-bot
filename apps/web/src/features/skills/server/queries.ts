import "server-only";
import { skills } from "@open-bot/db";
import { asc } from "drizzle-orm";
import { db } from "@/lib/server/db";
import type { SkillView } from "@/lib/types";

/** Every skill the owner or a teammate wrote, by name. */
export async function listSkills(): Promise<SkillView[]> {
  const rows = await db.select().from(skills).orderBy(asc(skills.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    botId: row.botId,
    createdBy: row.createdBy,
    createdByBotId: row.createdByBotId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
