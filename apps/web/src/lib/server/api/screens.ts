import "server-only";
import type { ApiInputs, ScreenFrame, ScreenView } from "@open-bot/api";
import { artifacts, desktopTakeovers, runs } from "@open-bot/db";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { listBots, workerStatus } from "../queries";
import { worker } from "../worker";

/**
 * Each screen's last frame: the newest screenshot its teammate took, by screen (a teammate's
 * screen has their id). Only the ids and times are read, never the images.
 */
export async function lastScreenFrames(): Promise<Record<string, ScreenFrame>> {
  const rows = await db
    .selectDistinctOn([runs.botId], {
      screenId: runs.botId,
      artifactId: artifacts.id,
      at: artifacts.createdAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(runs.id, artifacts.runId))
    .where(eq(artifacts.kind, "screenshot"))
    .orderBy(runs.botId, desc(artifacts.createdAt));
  return Object.fromEntries(
    rows.map((row) => [row.screenId, { artifactId: row.artifactId, at: row.at.toISOString() }]),
  );
}

export async function listScreens(): Promise<ScreenView[]> {
  const [bots, status, requests, frames] = await Promise.all([
    listBots(),
    workerStatus(),
    db
      .select()
      .from(desktopTakeovers)
      .where(inArray(desktopTakeovers.status, ["requested", "active"])),
    lastScreenFrames(),
  ]);
  return bots.map((bot) => {
    const screen = status?.computer.health?.screens.find((s) => s.id === bot.id);
    return {
      id: bot.id,
      bot,
      online: Boolean(status?.computer.online || status?.computer.lifecycle?.enabled),
      lifecycle: status?.computer.lifecycle ?? null,
      running: screen?.state === "running",
      lease: screen?.lease ?? null,
      requests: requests
        .filter((r) => r.screenId === bot.id)
        .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.createdAt.toISOString() })),
      lastFrame: frames[bot.id] ?? null,
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
