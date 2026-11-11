import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { ownerTimeZone, schedules, triggers } from "@open-bot/db";
import { DAILY_CHECK_IN } from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { publish } from "../publish";
import { worker } from "../worker";
import { ApiError } from "./errors";

export async function removeSchedule({
  scheduleId,
}: ApiInputs["schedules"]["remove"]): Promise<{ ok: true }> {
  await db.delete(schedules).where(eq(schedules.id, scheduleId));
  await publish({ type: "schedules" });
  return { ok: true };
}

/**
 * Turn a teammate's daily check-in on or off. Turning it on resumes a paused one rather than
 * adding another.
 */
export async function setCheckIn({
  teammateId,
  on,
}: ApiInputs["schedules"]["setCheckIn"]): Promise<{ ok: true }> {
  const existing = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.botId, teammateId),
        eq(schedules.title, DAILY_CHECK_IN.title),
        eq(schedules.quiet, true),
      ),
    );
  if (!on) {
    for (const row of existing)
      await worker.schedules.setEnabled({ scheduleId: row.id, enabled: false });
    return { ok: true };
  }
  if (existing[0]) {
    await worker.schedules.setEnabled({ scheduleId: existing[0].id, enabled: true });
    return { ok: true };
  }
  const timezone = await ownerTimeZone(db);
  await worker.schedules.create({
    botId: teammateId,
    title: DAILY_CHECK_IN.title,
    prompt: DAILY_CHECK_IN.prompt,
    cron: DAILY_CHECK_IN.cron,
    at: null,
    timezone,
    quiet: true,
  });
  return { ok: true };
}

/** Call a webhook with a sample request, as a service would. */
export async function testWebhook({
  triggerId,
}: ApiInputs["triggers"]["test"]): Promise<ApiOutputs["triggers"]["test"]> {
  const [row] = await db
    .select({ token: triggers.token })
    .from(triggers)
    .where(eq(triggers.id, triggerId));
  if (!row?.token) throw new ApiError("NOT_FOUND", "That webhook no longer exists.");
  return worker.hooks.fire({
    token: row.token,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ test: true, message: "A test request from the open-bot app" }),
    query: "",
  });
}
