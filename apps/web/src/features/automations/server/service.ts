import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { accounts, connections, ownerTimeZone, runs, schedules, triggers } from "@open-bot/db";
import { DAILY_CHECK_IN } from "@open-bot/domain";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";
import type { ScheduleRunView, ScheduleView, TriggerView } from "@/lib/types";

export async function removeSchedule({
  scheduleId,
}: ApiInputs["schedules"]["remove"]): Promise<{ ok: true }> {
  return worker.schedules.remove({ scheduleId });
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
        eq(schedules.teammateId, teammateId),
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
    teammateId,
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

export async function listSchedules(): Promise<ScheduleView[]> {
  const rows = await db.select().from(schedules).orderBy(asc(schedules.createdAt));
  const lastRuns = rows.length
    ? await db
        .selectDistinctOn([runs.scheduleId], {
          id: runs.id,
          scheduleId: runs.scheduleId,
          status: runs.status,
          chatId: runs.chatId,
        })
        .from(runs)
        .where(
          inArray(
            runs.scheduleId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(runs.scheduleId, desc(runs.createdAt))
    : [];
  return rows.map((row) => {
    const last = lastRuns.find((run) => run.scheduleId === row.id);
    return {
      id: row.id,
      teammateId: row.teammateId,
      title: row.title,
      prompt: row.prompt,
      kind: row.kind,
      cron: row.cron,
      runAt: row.runAt?.toISOString() ?? null,
      timezone: row.timezone,
      enabled: row.enabled,
      quiet: row.quiet,
      createdBy: row.createdBy,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastRun: last ? { id: last.id, status: last.status, chatId: last.chatId } : null,
    };
  });
}

export async function listTriggers(): Promise<TriggerView[]> {
  const rows = await db.select().from(triggers).orderBy(asc(triggers.createdAt));
  const connectionIds = [
    ...new Set(rows.map((row) => row.connectionId).filter((id): id is string => id !== null)),
  ];
  const watched = connectionIds.length
    ? await db
        .select({ id: connections.id, display: accounts.display, status: accounts.status })
        .from(connections)
        .innerJoin(accounts, eq(accounts.id, connections.accountId))
        .where(inArray(connections.id, connectionIds))
    : [];
  const lastRuns = rows.length
    ? await db
        .selectDistinctOn([runs.triggerId], {
          id: runs.id,
          triggerId: runs.triggerId,
          status: runs.status,
          chatId: runs.chatId,
        })
        .from(runs)
        .where(
          inArray(
            runs.triggerId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(runs.triggerId, desc(runs.createdAt))
    : [];
  return rows.map((row) => {
    const last = lastRuns.find((run) => run.triggerId === row.id);
    return {
      id: row.id,
      teammateId: row.teammateId,
      kind: row.kind,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled,
      createdBy: row.createdBy,
      url: row.url,
      intervalMinutes: row.intervalMinutes,
      lookFor: row.lookFor,
      connectionId: row.connectionId,
      account: watched.find((entry) => entry.id === row.connectionId)?.display ?? null,
      query: row.query,
      leadMinutes: row.leadMinutes,
      hookPath: row.token ? `/api/hooks/${row.token}` : null,
      nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
      lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
      lastRun: last ? { id: last.id, status: last.status, chatId: last.chatId } : null,
    };
  });
}

/** A schedule's, watch's or webhook's most recent runs, newest first. */
export async function listAutomationRuns(
  by: { scheduleId: string } | { triggerId: string },
  limit = 20,
): Promise<ScheduleRunView[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      "scheduleId" in by ? eq(runs.scheduleId, by.scheduleId) : eq(runs.triggerId, by.triggerId),
    )
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map((run) => ({
    id: run.id,
    chatId: run.chatId,
    status: run.status,
    trigger: run.trigger,
    preview: run.finalText ?? run.error ?? null,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  }));
}
