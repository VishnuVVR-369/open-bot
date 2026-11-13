import "server-only";
import { listSkills } from "@/features/skills/server";
import {
  approvals,
  bots,
  chatMembers,
  chats,
  desktopTakeovers,
  instructionProposals,
  messages,
  notifications,
  ownerSettings,
  ownerTimeZone,
  runs,
} from "@open-bot/db";
import { ACTIVE_RUN_STATUSES } from "@open-bot/domain";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, ne, sql } from "drizzle-orm";
import { OFFLINE_EGRESS_STATUS, type EgressStatusView } from "@open-bot/api";
import type { Attention } from "@open-bot/api";
import type {
  AppState,
  BotSummary,
  ChatSummary,
  NotificationView,
  ProfileView,
  TakeoverRequestSummary,
} from "../types";
import { db } from "./db";
import type { WorkerStatus } from "@open-bot/api/worker";
import { worker } from "./worker";
import { plainText } from "../utils";

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

export async function listBots(): Promise<BotSummary[]> {
  const rows = await db
    .select()
    .from(bots)
    .where(isNull(bots.archivedAt))
    .orderBy(asc(bots.createdAt));
  // Each teammate's main chat. One whose main chat isn't marked, because a worker from before main
  // chats added or archived it, shows its most recently active open direct chat: the one the
  // worker hands the role to when work arrives.
  const chatTeammate = chats.botId; // vocabulary: allow
  const mainChats = await db
    .selectDistinctOn([chatTeammate], { id: chats.id, teammateId: chatTeammate })
    .from(chats)
    .where(and(eq(chats.kind, "direct"), isNull(chats.archivedAt)))
    .orderBy(chatTeammate, desc(chats.main), desc(chats.lastActivityAt), desc(chats.createdAt));
  const active = await db
    .select({
      id: runs.id,
      botId: runs.botId,
      chatId: runs.chatId,
      status: runs.status,
      waitingFor: runs.waitingFor,
    })
    .from(runs)
    .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
    .orderBy(desc(runs.createdAt));
  // Each teammate's newest run, read through runs_bot_idx: when it finished, or when it began.
  const latest = await db
    .selectDistinctOn([runs.botId], {
      botId: runs.botId,
      at: sql<Date>`coalesce(${runs.completedAt}, ${runs.startedAt}, ${runs.createdAt})`.mapWith(
        runs.createdAt,
      ),
    })
    .from(runs)
    .orderBy(runs.botId, desc(runs.createdAt));
  return rows.map((bot) => {
    const run =
      active.find((r) => r.botId === bot.id && r.status !== "queued") ??
      active.find((r) => r.botId === bot.id);
    return {
      id: bot.id,
      name: bot.name,
      slug: bot.slug,
      role: bot.role,
      color: bot.color,
      emoji: bot.emoji,
      autonomy: bot.autonomy,
      isPrimary: bot.isPrimary,
      directChatId: mainChats.find((chat) => chat.teammateId === bot.id)?.id ?? null,
      lastActiveAt: latest.find((entry) => entry.botId === bot.id)?.at.toISOString() ?? null,
      activeRun: run
        ? { id: run.id, chatId: run.chatId, status: run.status, waitingFor: run.waitingFor ?? null }
        : null,
    };
  });
}

/** Your chats, newest first. `previews` adds what was said last in each, for lists. */
export async function listChats({ helpers = false, previews: withPreviews = true } = {}): Promise<
  ChatSummary[]
> {
  const rows = await db
    .select()
    .from(chats)
    // A swarm helper's chat shows inside its teammate's chat, not in your list.
    .where(and(isNull(chats.archivedAt), helpers ? undefined : ne(chats.kind, "helper")))
    .orderBy(desc(chats.lastActivityAt));
  const members = await db.select().from(chatMembers);
  const activeChats = await db
    .selectDistinct({ chatId: runs.chatId })
    .from(runs)
    .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]));
  const activeSet = new Set(activeChats.map((row) => row.chatId));
  // When a teammate last finished replying in each chat, for unread.
  const replies = await db
    .select({ chatId: runs.chatId, at: max(runs.completedAt) })
    .from(runs)
    .where(inArray(runs.status, ["completed", "failed"]))
    .groupBy(runs.chatId);
  const lastReply = new Map(replies.map((row) => [row.chatId, row.at]));
  const previews = withPreviews ? await chatPreviews() : new Map();
  return rows.map((chat) => ({
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    botId: chat.botId,
    main: chat.main,
    memberIds:
      chat.kind === "group"
        ? members.filter((member) => member.chatId === chat.id).map((member) => member.botId)
        : chat.botId
          ? [chat.botId]
          : [],
    lastActivityAt: chat.lastActivityAt.toISOString(),
    active: activeSet.has(chat.id),
    unread: (lastReply.get(chat.id)?.getTime() ?? 0) > chat.readAt.getTime(),
    preview: previews.get(chat.id) ?? null,
  }));
}

/** How long a chat's preview gets: more than a list row shows, so each app can cut it to fit. */
const PREVIEW_LENGTH = 160;

/** The latest thing said in each chat: your last message or a teammate's last reply. */
async function chatPreviews(): Promise<Map<string, NonNullable<ChatSummary["preview"]>>> {
  const [sent, replied] = await Promise.all([
    db
      .selectDistinctOn([messages.chatId], {
        chatId: messages.chatId,
        text: messages.text,
        attachments: messages.attachments,
        at: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.role, "user"))
      .orderBy(messages.chatId, desc(messages.createdAt)),
    db
      .selectDistinctOn([runs.chatId], {
        chatId: runs.chatId,
        botId: runs.botId,
        text: runs.finalText,
        at: runs.createdAt,
        completedAt: runs.completedAt,
      })
      .from(runs)
      .where(isNotNull(runs.finalText))
      .orderBy(runs.chatId, desc(runs.createdAt)),
  ]);
  const previews = new Map<string, { text: string; botId: string | null; at: Date }>();
  for (const message of sent) {
    const text = plainText(message.text) || message.attachments[0]?.name || "";
    if (text) previews.set(message.chatId, { text, botId: null, at: message.at });
  }
  for (const reply of replied) {
    const text = plainText(reply.text ?? "");
    const at = reply.completedAt ?? reply.at;
    const mine = previews.get(reply.chatId);
    if (text && (!mine || at >= mine.at))
      previews.set(reply.chatId, { text, botId: reply.botId, at });
  }
  return new Map(
    [...previews].map(([chatId, { text, botId }]) => [
      chatId,
      { text: text.slice(0, PREVIEW_LENGTH), botId },
    ]),
  );
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
      listBots(),
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

export async function getProfile(): Promise<ProfileView> {
  const row = await ownerSettings(db);
  return {
    aboutMe: row?.aboutMe ?? "",
    updatedAt: row?.aboutMeUpdatedAt?.toISOString() ?? null,
  };
}
