// What a teammate is made of besides its profile, read for copying and exporting it.
import { approvalRules, lessons, type Queryable, schedules, skills, triggers } from "@open-bot/db";
import type { TeammateBundle } from "@open-bot/domain";
import { and, asc, eq, isNotNull } from "drizzle-orm";

/** What a teammate is made of besides its profile: what copying and exporting carry over. */
export type TeammateParts = Omit<TeammateBundle, "format" | "version" | "teammate">;

/** A teammate's own skills, routines, page watches, approval rules and lessons. */
export async function teammateParts(db: Queryable, id: string): Promise<TeammateParts> {
  const [ownSkills, routines, watches, allowed, learned] = await Promise.all([
    db.select().from(skills).where(eq(skills.teammateId, id)).orderBy(asc(skills.name)),
    db
      .select()
      .from(schedules)
      .where(
        and(eq(schedules.teammateId, id), eq(schedules.kind, "cron"), isNotNull(schedules.cron)),
      )
      .orderBy(asc(schedules.createdAt)),
    db
      .select()
      .from(triggers)
      .where(and(eq(triggers.teammateId, id), eq(triggers.kind, "watch")))
      .orderBy(asc(triggers.createdAt)),
    db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.teammateId, id))
      .orderBy(asc(approvalRules.createdAt)),
    db.select().from(lessons).where(eq(lessons.teammateId, id)).orderBy(asc(lessons.createdAt)),
  ]);
  return {
    skills: ownSkills.map(({ name, description, instructions }) => ({
      name,
      description,
      instructions,
    })),
    routines: routines.map((routine) => ({
      title: routine.title,
      prompt: routine.prompt,
      cron: routine.cron!,
      quiet: routine.quiet,
    })),
    watches: watches.map((watch) => ({
      title: watch.title,
      prompt: watch.prompt,
      url: watch.url!,
      intervalMinutes: watch.intervalMinutes!,
      lookFor: watch.lookFor,
    })),
    allowed: allowed.map((rule) => ({ kind: rule.kind, pattern: rule.pattern })),
    lessons: learned.map((lesson) => lesson.text),
  };
}
