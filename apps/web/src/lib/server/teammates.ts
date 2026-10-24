import "server-only";
import { approvalRules, lessons, schedules, skills, triggers } from "@open-bot/db";
import { BUNDLE_FORMAT, BUNDLE_VERSION, nextCronRun, type TeammateBundle } from "@open-bot/shared";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "./db";

/** What a teammate is made of besides its profile: what duplicating and exporting carry over. */
export type TeammateParts = Omit<TeammateBundle, "format" | "version" | "teammate">;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function teammateParts(botId: string): Promise<TeammateParts> {
  const [ownSkills, routines, watches, allowed, learned] = await Promise.all([
    db.select().from(skills).where(eq(skills.botId, botId)).orderBy(asc(skills.name)),
    db
      .select()
      .from(schedules)
      .where(and(eq(schedules.botId, botId), eq(schedules.kind, "cron"), isNotNull(schedules.cron)))
      .orderBy(asc(schedules.createdAt)),
    db
      .select()
      .from(triggers)
      .where(and(eq(triggers.botId, botId), eq(triggers.kind, "watch")))
      .orderBy(asc(triggers.createdAt)),
    db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.botId, botId))
      .orderBy(asc(approvalRules.createdAt)),
    db.select().from(lessons).where(eq(lessons.botId, botId)).orderBy(asc(lessons.createdAt)),
  ]);
  return {
    skills: ownSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
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

/**
 * Gives a new teammate these parts. Routines and watches start paused, so nothing runs twice
 * or by surprise; you turn them on in Automations.
 */
export async function insertTeammateParts(
  tx: Transaction,
  botId: string,
  parts: TeammateParts,
  timezone: string,
): Promise<void> {
  if (parts.skills.length > 0)
    await tx
      .insert(skills)
      .values(parts.skills.map((skill) => ({ ...skill, botId, createdBy: "user" as const })));
  const routines = parts.routines.flatMap((routine) => {
    try {
      // A cron this open-bot can't read is left out rather than failing the whole teammate.
      return [{ ...routine, nextRunAt: nextCronRun(routine.cron, timezone) }];
    } catch {
      return [];
    }
  });
  if (routines.length > 0)
    await tx.insert(schedules).values(
      routines.map((routine) => ({
        botId,
        title: routine.title,
        prompt: routine.prompt,
        kind: "cron" as const,
        cron: routine.cron,
        quiet: routine.quiet,
        timezone,
        nextRunAt: routine.nextRunAt,
        enabled: false,
        createdBy: "user" as const,
      })),
    );
  if (parts.watches.length > 0)
    await tx.insert(triggers).values(
      parts.watches.map((watch) => ({
        botId,
        kind: "watch" as const,
        ...watch,
        enabled: false,
        createdBy: "user" as const,
      })),
    );
  if (parts.allowed.length > 0)
    await tx.insert(approvalRules).values(parts.allowed.map((rule) => ({ botId, ...rule })));
  if (parts.lessons.length > 0)
    await tx.insert(lessons).values(parts.lessons.map((text) => ({ botId, text })));
}

/** A teammate as a file. */
export function toBundle(
  teammate: TeammateBundle["teammate"],
  parts: TeammateParts,
): TeammateBundle {
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, teammate, ...parts };
}
