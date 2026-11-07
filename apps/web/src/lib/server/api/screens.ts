import "server-only";
import type { ApiInputs, ApiOutputs, ScreenView } from "@open-bot/api";
import { desktopTakeovers } from "@open-bot/db";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { listBots, workerStatus } from "../queries";
import { worker } from "../worker";

export async function listScreens(): Promise<ScreenView[]> {
  const [bots, status, requests] = await Promise.all([
    listBots(),
    workerStatus(),
    db
      .select()
      .from(desktopTakeovers)
      .where(inArray(desktopTakeovers.status, ["requested", "active"])),
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
    };
  });
}

export async function takeOverScreen({ screenId }: ApiInputs["screens"]["takeOver"]) {
  await worker("POST", `/internal/screens/${screenId}/take`);
  return { ok: true as const };
}
export async function handBackScreen({
  screenId,
  note,
  clearCode,
}: ApiInputs["screens"]["handBack"]) {
  await worker("POST", `/internal/screens/${screenId}/hand-back`, { note, clearCode });
  return { ok: true as const };
}
export async function wakeScreen({ screenId }: ApiInputs["screens"]["wake"]) {
  await worker("POST", `/internal/screens/${screenId}/wake`, undefined, 300_000);
  return { ok: true as const };
}
export async function reportScreenActivity({ screenId }: ApiInputs["screens"]["activity"]) {
  await worker("POST", `/internal/screens/${screenId}/touch`);
  return { ok: true as const };
}
export async function dismissTakeoverRequest({ takeoverId }: ApiInputs["takeovers"]["dismiss"]) {
  await worker("POST", `/internal/takeover/${takeoverId}/dismiss`);
  return { ok: true as const };
}
export const codeContext = ({ takeoverId }: ApiInputs["takeovers"]["codeContext"]) =>
  worker<ApiOutputs["takeovers"]["codeContext"]>(
    "GET",
    `/internal/takeover/${takeoverId}/code-context`,
  );
export const typeOnScreen = (input: ApiInputs["screenOperations"]["type"]) =>
  worker<ApiOutputs["screenOperations"]["type"]>("POST", "/internal/screens/code", input, 180_000);
export const getScreenOperation = ({ operationId }: ApiInputs["screenOperations"]["get"]) =>
  worker<ApiOutputs["screenOperations"]["get"]>(
    "GET",
    `/internal/screen-operations/${operationId}`,
  );
export const cancelScreenOperation = ({ operationId }: ApiInputs["screenOperations"]["cancel"]) =>
  worker<ApiOutputs["screenOperations"]["cancel"]>(
    "POST",
    `/internal/screen-operations/${operationId}/cancel`,
  );
