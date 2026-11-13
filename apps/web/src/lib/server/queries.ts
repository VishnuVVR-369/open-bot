import "server-only";
import { listSkills } from "@/features/skills/server";
import { listTeammates } from "@/features/teammates/server";
import { listChats } from "@/features/chat/server";
import {
  approvals,
  bots,
  desktopTakeovers,
  instructionProposals,
  notifications,
  ownerTimeZone,
  runs,
} from "@open-bot/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { OFFLINE_EGRESS_STATUS, type EgressStatusView, type Attention } from "@open-bot/api";
import type { AppState, NotificationView, TakeoverRequestSummary } from "../types";
import { db } from "./db";
import type { WorkerStatus } from "@open-bot/api/worker";
import { worker } from "./worker";

/** The worker's status, or null when it doesn't answer quickly. */
export async function workerStatus(): Promise<WorkerStatus | null> {
  try {
    const status = await worker.status.get(undefined, { context: { timeoutMs: 2_500 } });
    return { ...status, egress: withEgressDefaults(status.egress) };
  } catch {
    return null;
  }
}

/**
 * A worker deployed before phones could carry traffic reports only the desktop's state; fill in
 * the rest so the web and a newer worker can roll out in either order.
 */
function withEgressDefaults(egress: Partial<EgressStatusView>): EgressStatusView {
  const merged = { ...OFFLINE_EGRESS_STATUS, ...egress };
  if (egress.path) return merged;
  const path =
    merged.mode !== "off" && merged.agentOnline
      ? "desktop"
      : merged.mode === "require"
        ? "blocked"
        : "direct";
  return { ...merged, path };
}

/** Teammates waiting for you to take over their screen, newest first. */
export async function listTakeoverRequests(): Promise<TakeoverRequestSummary[]> {
  const rows = await db
    .select({
      id: desktopTakeovers.id,
      screenId: desktopTakeovers.screenId,
      botId: desktopTakeovers.requestedByBotId,
      botName: bots.name,
      reason: desktopTakeovers.reason,
      chatId: runs.chatId,
      createdAt: desktopTakeovers.createdAt,
    })
    .from(desktopTakeovers)
    .leftJoin(bots, eq(bots.id, desktopTakeovers.requestedByBotId))
    .leftJoin(runs, eq(runs.id, desktopTakeovers.requestedByRunId))
    .where(eq(desktopTakeovers.status, "requested"))
    .orderBy(desc(desktopTakeovers.createdAt));
  return rows.flatMap((row) => {
    const screenId = row.screenId ?? row.botId;
    if (!screenId) return [];
    return [
      {
        id: row.id,
        screenId,
        botId: row.botId,
        botName: row.botName ?? "A bot",
        reason: row.reason ?? "",
        chatId: row.chatId,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}

/** What needs you, for the badges on every screen and on the phone's Home. */
export async function getAttention(): Promise<Attention> {
  const [[pending], takeoverRequests, proposals, [unread]] = await Promise.all([
    db.select({ value: count() }).from(approvals).where(eq(approvals.status, "pending")),
    listTakeoverRequests(),
    db
      .select({ id: instructionProposals.id, botId: instructionProposals.botId })
      .from(instructionProposals)
      .innerJoin(bots, eq(bots.id, instructionProposals.botId))
      .where(and(eq(instructionProposals.status, "pending"), isNull(bots.archivedAt)))
      .orderBy(desc(instructionProposals.createdAt)),
    db.select({ value: count() }).from(notifications).where(isNull(notifications.readAt)),
  ]);
  return {
    pendingApprovals: pending?.value ?? 0,
    takeoverRequests,
    proposals,
    unreadNotifications: unread?.value ?? 0,
  };
}

export async function getAppState(user: { name: string; email: string }): Promise<AppState> {
  const [botList, chatList, status, attention, activeTakeovers, timezone, skillList] =
    await Promise.all([
      listTeammates(),
      listChats({ previews: false }),
      workerStatus(),
      getAttention(),
      db
        .select({
          id: desktopTakeovers.id,
          screenId: desktopTakeovers.screenId,
          startedAt: desktopTakeovers.startedAt,
        })
        .from(desktopTakeovers)
        .where(eq(desktopTakeovers.status, "active"))
        .orderBy(desc(desktopTakeovers.createdAt)),
      ownerTimeZone(db),
      listSkills(),
    ]);
  return {
    ...attention,
    user,
    timezone,
    bots: botList,
    chats: chatList,
    skills: skillList.map(({ instructions: _, ...summary }) => summary),
    computer: {
      workerOnline: status !== null,
      lifecycle: status?.computer.lifecycle ?? null,
      online: status?.computer.online ?? false,
      health: status?.computer.health ?? null,
      egress: status?.egress ?? OFFLINE_EGRESS_STATUS,
    },
    codex: status?.codex ?? null,
    activeTakeovers: activeTakeovers.flatMap((row) =>
      row.screenId
        ? [{ id: row.id, screenId: row.screenId, startedAt: row.startedAt?.toISOString() ?? null }]
        : [],
    ),
  };
}

export async function listNotifications(limit = 40): Promise<NotificationView[]> {
  const rows = await db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    botId: row.botId,
    chatId: row.chatId,
    runId: row.runId,
    pageId: row.pageId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
