import { schedules } from "@open-bot/db";
import { isNothingToReport } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import type { Context } from "../context";

/** A quiet routine's run that found nothing worth telling you. */
export async function quietWithNothingToReport(
  ctx: Context,
  run: { trigger: string; scheduleId: string | null },
  text: string | null,
): Promise<boolean> {
  if (run.trigger !== "schedule" || !run.scheduleId || !isNothingToReport(text)) return false;
  const [schedule] = await ctx.db
    .select({ quiet: schedules.quiet })
    .from(schedules)
    .where(eq(schedules.id, run.scheduleId));
  return schedule?.quiet ?? false;
}
