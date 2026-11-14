import "server-only";
import type { ApiInputs, ScreenFrame, ScreenView } from "@open-bot/api";
import { artifacts, screenTakeovers, runs } from "@open-bot/db";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { listTeammates } from "@/features/teammates/server";
import { workerStatus } from "@/lib/server/worker-status";
import { worker } from "@/lib/server/worker";

/**
 * Each screen's last frame: the newest screenshot its teammate took, by screen (a teammate's
 * screen has their id). Only the ids and times are read, never the images.
 */
export async function lastScreenFrames(): Promise<Record<string, ScreenFrame>> {
  const rows = await db
    .selectDistinctOn([runs.teammateId], {
      screenId: runs.teammateId,
      artifactId: artifacts.id,
      at: artifacts.createdAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(runs.id, artifacts.runId))
    .where(eq(artifacts.kind, "screenshot"))
    .orderBy(runs.teammateId, desc(artifacts.createdAt));
  return Object.fromEntries(
    rows.map((row) => [row.screenId, { artifactId: row.artifactId, at: row.at.toISOString() }]),
  );
}

export async function listScreens(): Promise<ScreenView[]> {
  const [teammates, status, requests, frames] = await Promise.all([
    listTeammates(),
    workerStatus(),
    db
      .select()
      .from(screenTakeovers)
      .where(inArray(screenTakeovers.status, ["requested", "active"])),
    lastScreenFrames(),
  ]);
  return teammates.map((teammate) => {
    const screen = status?.computer.health?.screens.find((s) => s.id === teammate.id);
    return {
      id: teammate.id,
      teammate,
      online: Boolean(status?.computer.online || status?.computer.lifecycle?.enabled),
      lifecycle: status?.computer.lifecycle ?? null,
      running: screen?.state === "running",
      lease: screen?.lease ?? null,
      requests: requests
        .filter((r) => r.screenId === teammate.id)
        .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.createdAt.toISOString() })),
      lastFrame: frames[teammate.id] ?? null,
    };
  });
}

export async function takeOverScreen({ screenId }: ApiInputs["screens"]["takeOver"]) {
  await worker.screens.take({ screenId });
  return { ok: true as const };
}
export async function handBackScreen({
  screenId,
  note,
  clearCode,
}: ApiInputs["screens"]["handBack"]) {
  await worker.screens.handBack({ screenId, note, clearCode });
  return { ok: true as const };
}
export async function wakeScreen({ screenId }: ApiInputs["screens"]["wake"]) {
  await worker.screens.wake({ screenId });
  return { ok: true as const };
}
export async function reportScreenActivity({ screenId }: ApiInputs["screens"]["activity"]) {
  await worker.screens.touch({ screenId });
  return { ok: true as const };
}
export async function dismissTakeoverRequest({ takeoverId }: ApiInputs["takeovers"]["dismiss"]) {
  await worker.takeovers.dismiss({ takeoverId });
  return { ok: true as const };
}
export const codeContext = (input: ApiInputs["takeovers"]["codeContext"]) =>
  worker.takeovers.codeContext(input);
export const typeOnScreen = (input: ApiInputs["screenOperations"]["type"]) =>
  worker.screens.typeCode(input, { context: { timeoutMs: 180_000 } });
export const getScreenOperation = (input: ApiInputs["screenOperations"]["get"]) =>
  worker.screenOperations.get(input);
export const cancelScreenOperation = (input: ApiInputs["screenOperations"]["cancel"]) =>
  worker.screenOperations.cancel(input);
