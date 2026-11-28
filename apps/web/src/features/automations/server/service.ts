import { runColumns } from "@/lib/server/run-columns";
import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { accountConnections, connections, runs, schedules, triggers } from "@open-bot/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { db } from "@/lib/server/db";
import { FINISHING_UPDATE, isMissingRoute, worker } from "@/lib/server/worker";
import type { ScheduleRunView, ScheduleView, TriggerView } from "@/lib/types";

export async function removeSchedule({
  scheduleId,
}: ApiInputs["schedules"]["remove"]): Promise<{ ok: true }> {
  return worker.schedules.remove({ scheduleId });
}

/**
 * Rename a schedule or change its timing, and nothing else (the phone's edit). A worker from before
 * `patch`, for the minute a deploy takes, can't; sending the whole schedule instead could undo an
 * edit made meanwhile, so it's refused with nothing changed.
 */
export async function patchSchedule(
  input: ApiInputs["schedules"]["patch"],
): Promise<ApiOutputs["schedules"]["patch"]> {
  try {
    return await worker.schedules.patch(input);
  } catch (error) {
    if (isMissingRoute(error)) throw new ApiError("BAD_REQUEST", FINISHING_UPDATE);
    throw error;
  }
}

/** Rename a trigger or change its timing, and nothing else, as `patchSchedule` does. */
export async function patchTrigger(
  input: ApiInputs["triggers"]["patch"],
): Promise<ApiOutputs["triggers"]["patch"]> {
  try {
    return await worker.triggers.patch(input);
  } catch (error) {
    if (isMissingRoute(error)) throw new ApiError("BAD_REQUEST", FINISHING_UPDATE);
    throw error;
  }
}

/**
 * Turn a teammate's daily check-in on or off. The worker finds it by its mark, so a renamed one is
 * still found, and turning it on resumes it rather than adding another. A worker from before that
 * route, for the minute a deploy takes, can't; it's refused with nothing changed.
 */
export async function setCheckIn(
  input: ApiInputs["schedules"]["setCheckIn"],
): Promise<{ ok: true }> {
  try {
    return await worker.schedules.setCheckIn(input);
  } catch (error) {
    if (isMissingRoute(error)) throw new ApiError("BAD_REQUEST", FINISHING_UPDATE);
    throw error;
  }
}

/**
 * Run a schedule now. A worker from before `started` answers only `ok`, and it ignores `runId`, so
 * it started a run whatever was asked (see `POST /internal/schedules/:id/run` in
 * `reference/http-api` in the site docs).
 */
export async function runScheduleNow(
  input: ApiInputs["schedules"]["runNow"],
): Promise<ApiOutputs["schedules"]["runNow"]> {
  const answer: { started?: boolean } = await worker.schedules.runNow(input);
  return { ok: true, started: answer.started ?? true };
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
      checkIn: row.checkIn,
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
        .select({
          id: connections.id,
          display: accountConnections.display,
          status: accountConnections.status,
        })
        .from(connections)
        .innerJoin(accountConnections, eq(accountConnections.id, connections.accountId))
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
    .select(runColumns)
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
