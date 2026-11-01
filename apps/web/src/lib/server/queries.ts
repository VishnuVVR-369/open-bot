import "server-only";
import { randomBytes } from "node:crypto";
import {
  approvals,
  bots,
  credentials,
  chatMembers,
  chats,
  connections,
  emailSettings,
  desktopTakeovers,
  instructionProposals,
  lessons,
  messages,
  notifications,
  purchases,
  runEvents,
  runs,
  schedules,
  settings,
  skills,
  swarms,
  swarmTasks,
  tasks,
  triggers,
  usageEntries,
  vaultItems,
} from "@open-bot/db";
import {
  ACTIVE_RUN_STATUSES,
  applyRunEvent,
  emailAddress,
  emptyTimeline,
  isNothingToReport,
  monthStart,
  PAGE_TEXT_NOTE,
  WEBHOOK_PAYLOAD_NOTE,
  type RunStatus,
} from "@open-bot/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  max,
  ne,
  sql,
} from "drizzle-orm";
import type {
  ActivityView,
  AppState,
  ApprovalView,
  BotSummary,
  BriefingItem,
  ChatData,
  ChatEntry,
  ChatSummary,
  CodexStatusView,
  ConnectionView,
  EmailStatusView,
  LessonView,
  ProposalView,
  TaskView,
  ComputerView,
  MessageView,
  ModelAccessView,
  NotificationView,
  RunView,
  ScheduleRunView,
  SearchResultView,
  ScheduleView,
  SkillView,
  ProfileView,
  PurchaseView,
  SpendingView,
  TriggerView,
  UsageView,
  VaultItemView,
} from "../types";
import { db } from "./db";
import { worker } from "./worker";
import { plainText } from "../utils";

interface WorkerStatus {
  computer: { online: boolean; health: ComputerView["health"] };
  codex: CodexStatusView;
  egress: ComputerView["egress"];
}

export async function workerStatus(): Promise<WorkerStatus | null> {
  try {
    return await worker<WorkerStatus>("GET", "/internal/status", undefined, 2_500);
  } catch {
    return null;
  }
}

export async function listBots(): Promise<BotSummary[]> {
  const rows = await db
    .select()
    .from(bots)
    .where(isNull(bots.archivedAt))
    .orderBy(asc(bots.createdAt));
  const directChats = await db
    .select({ id: chats.id, botId: chats.botId })
    .from(chats)
    .where(and(eq(chats.kind, "direct"), isNull(chats.archivedAt)))
    .orderBy(asc(chats.createdAt));
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
      directChatId: directChats.find((chat) => chat.botId === bot.id)?.id ?? null,
      activeRun: run
        ? { id: run.id, chatId: run.chatId, status: run.status, waitingFor: run.waitingFor ?? null }
        : null,
    };
  });
}

export async function listChats({ helpers = false } = {}): Promise<ChatSummary[]> {
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
  return rows.map((chat) => ({
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    botId: chat.botId,
    memberIds:
      chat.kind === "group"
        ? members.filter((member) => member.chatId === chat.id).map((member) => member.botId)
        : chat.botId
          ? [chat.botId]
          : [],
    lastActivityAt: chat.lastActivityAt.toISOString(),
    active: activeSet.has(chat.id),
  }));
}

export async function listSkills(): Promise<SkillView[]> {
  const rows = await db.select().from(skills).orderBy(asc(skills.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    botId: row.botId,
    createdBy: row.createdBy,
    createdByBotId: row.createdByBotId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getAppState(user: { name: string; email: string }): Promise<AppState> {
  const [
    botList,
    chatList,
    status,
    [approvalCount],
    requests,
    activeTakeovers,
    [unread],
    [settingsRow],
    skillList,
    proposals,
  ] = await Promise.all([
    listBots(),
    listChats(),
    workerStatus(),
    db.select({ value: count() }).from(approvals).where(eq(approvals.status, "pending")),
    db
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
      .orderBy(desc(desktopTakeovers.createdAt)),
    db
      .select({
        id: desktopTakeovers.id,
        screenId: desktopTakeovers.screenId,
        startedAt: desktopTakeovers.startedAt,
      })
      .from(desktopTakeovers)
      .where(eq(desktopTakeovers.status, "active"))
      .orderBy(desc(desktopTakeovers.createdAt)),
    db.select({ value: count() }).from(notifications).where(isNull(notifications.readAt)),
    db.select({ timezone: settings.timezone }).from(settings).where(eq(settings.id, 1)),
    listSkills(),
    db
      .select({ id: instructionProposals.id, botId: instructionProposals.botId })
      .from(instructionProposals)
      .innerJoin(bots, eq(bots.id, instructionProposals.botId))
      .where(and(eq(instructionProposals.status, "pending"), isNull(bots.archivedAt)))
      .orderBy(desc(instructionProposals.createdAt)),
  ]);
  return {
    user,
    timezone: settingsRow?.timezone ?? "UTC",
    bots: botList,
    chats: chatList,
    skills: skillList.map(({ instructions: _, ...summary }) => summary),
    computer: {
      workerOnline: status !== null,
      online: status?.computer.online ?? false,
      health: status?.computer.health ?? null,
      egress: status?.egress ?? {
        mode: "prefer",
        agentOnline: false,
        computerConnected: false,
        stats: null,
      },
    },
    codex: status?.codex ?? null,
    pendingApprovals: approvalCount?.value ?? 0,
    proposals,
    takeoverRequests: requests.flatMap((row) => {
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
    }),
    activeTakeovers: activeTakeovers.flatMap((row) =>
      row.screenId
        ? [{ id: row.id, screenId: row.screenId, startedAt: row.startedAt?.toISOString() ?? null }]
        : [],
    ),
    unreadNotifications: unread?.value ?? 0,
  };
}

function toMessageView(row: typeof messages.$inferSelect): MessageView {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    attachments: row.attachments,
    mentions: row.mentions,
    steeredRunId: row.steeredRunId,
    redoOfRunId: row.redoOfRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

const PAGE = 30;

export async function getChatData(chatId: string, before?: string): Promise<ChatData | null> {
  const chatList = await listChats({ helpers: true });
  const chat = chatList.find((entry) => entry.id === chatId);
  if (!chat) return null;
  const helper = chat.kind === "helper" ? await helperOf(chatId) : null;
  const allBots = await listBots();
  const members = allBots.filter((bot) => chat.memberIds.includes(bot.id));
  const beforeDate = before ? new Date(before) : null;

  const [messageRows, runRows] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          beforeDate ? lt(messages.createdAt, beforeDate) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(PAGE),
    db
      .select({ run: runs, scheduleTitle: schedules.title, triggerTitle: triggers.title })
      .from(runs)
      .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
      .leftJoin(triggers, eq(triggers.id, runs.triggerId))
      .where(and(eq(runs.chatId, chatId), beforeDate ? lt(runs.createdAt, beforeDate) : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(PAGE),
  ]);

  const runIds = runRows.map((row) => row.run.id);
  const events = runIds.length
    ? await db
        .select({ id: runEvents.id, runId: runEvents.runId, payload: runEvents.payload })
        .from(runEvents)
        .where(inArray(runEvents.runId, runIds))
        .orderBy(asc(runEvents.id))
    : [];
  const usage = await usageByRun(runIds);
  const [cursorRow] = await db
    .select({ value: max(runEvents.id) })
    .from(runEvents)
    .where(eq(runEvents.chatId, chatId));

  const parentIds = runRows
    .map((row) => row.run.parentRunId)
    .filter((id): id is string => Boolean(id));
  const parents = parentIds.length
    ? await db
        .select({ id: runs.id, botId: runs.botId })
        .from(runs)
        .where(inArray(runs.id, parentIds))
    : [];

  const runViews: RunView[] = runRows.map(({ run, scheduleTitle, triggerTitle }) => {
    let timeline = emptyTimeline(run.status as RunStatus);
    for (const event of events)
      if (event.runId === run.id) timeline = applyRunEvent(timeline, event.payload);
    // The row is the source of truth for status, in case an event was lost.
    timeline = { ...timeline, status: run.status, error: run.error ?? timeline.error };
    return {
      id: run.id,
      botId: run.botId,
      trigger: run.trigger,
      messageId: run.messageId,
      parentRunId: run.parentRunId,
      authMode: run.authMode ?? null,
      fromBotId:
        run.trigger === "handoff" || run.trigger === "question" || run.trigger === "answer"
          ? (parents.find((p) => p.id === run.parentRunId)?.botId ?? null)
          : null,
      scheduleTitle,
      triggerTitle,
      automationPrompt: automationPrompt(run),
      rating: run.rating ?? null,
      usage: usage.get(run.id) ?? null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      timeline,
    };
  });

  const entries: ChatEntry[] = [
    ...messageRows.map((row) => ({
      type: "message" as const,
      at: row.createdAt.toISOString(),
      message: toMessageView(row),
    })),
    ...runViews.map((run) => ({ type: "run" as const, at: run.createdAt, run })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    chat,
    members,
    entries,
    cursor: Number(cursorRow?.value ?? 0),
    hasMore: messageRows.length === PAGE || runRows.length === PAGE,
    helper,
  };
}

/** For a swarm helper's chat: its screen, and the swarm it's part of. */
async function helperOf(chatId: string): Promise<ChatData["helper"]> {
  const [row] = await db
    .select({ task: swarmTasks, swarm: swarms })
    .from(swarmTasks)
    .innerJoin(swarms, eq(swarms.id, swarmTasks.swarmId))
    .where(eq(swarmTasks.chatId, chatId));
  if (!row) return null;
  return {
    screenId: row.task.id,
    state: row.task.status,
    swarmTitle: row.swarm.title,
    swarmChatId: row.swarm.chatId,
    swarmRunId: row.swarm.runId,
  };
}

/** Tokens and cost per run, from the usage ledger. */
async function usageByRun(
  runIds: string[],
): Promise<Map<string, { tokens: number; costMicros: number }>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({
      runId: usageEntries.runId,
      tokens: sql<string>`sum(${usageEntries.inputTokens} + ${usageEntries.outputTokens})`,
      costMicros: sql<string>`sum(${usageEntries.costMicros})`,
    })
    .from(usageEntries)
    .where(inArray(usageEntries.runId, runIds))
    .groupBy(usageEntries.runId);
  return new Map(
    rows.map((row) => [
      row.runId!,
      { tokens: Number(row.tokens), costMicros: Number(row.costMicros) },
    ]),
  );
}

/** What an automation gave the teammate, without the header line naming the automation. */
function automationPrompt(run: { trigger: string; prompt: string }): string | null {
  if (run.trigger !== "schedule" && run.trigger !== "watch" && run.trigger !== "webhook")
    return null;
  // The warnings about outside text are for the teammate, not for you.
  return run.prompt
    .replace(/^\[(Scheduled task|Watch|Webhook): "[^\n]*"\]\n+/, "")
    .replace(WEBHOOK_PAYLOAD_NOTE, "It received:")
    .replace(` ${PAGE_TEXT_NOTE}`, "");
}

export async function getRunView(runId: string): Promise<RunView | null> {
  const [row] = await db
    .select({ run: runs, scheduleTitle: schedules.title, triggerTitle: triggers.title })
    .from(runs)
    .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
    .leftJoin(triggers, eq(triggers.id, runs.triggerId))
    .where(eq(runs.id, runId));
  if (!row) return null;
  const events = await db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.id));
  let timeline = emptyTimeline(row.run.status);
  for (const event of events) timeline = applyRunEvent(timeline, event.payload);
  return {
    id: row.run.id,
    botId: row.run.botId,
    trigger: row.run.trigger,
    messageId: row.run.messageId,
    parentRunId: row.run.parentRunId,
    fromBotId: null,
    authMode: row.run.authMode ?? null,
    scheduleTitle: row.scheduleTitle,
    triggerTitle: row.triggerTitle,
    automationPrompt: automationPrompt(row.run),
    rating: row.run.rating ?? null,
    usage: (await usageByRun([row.run.id])).get(row.run.id) ?? null,
    createdAt: row.run.createdAt.toISOString(),
    startedAt: row.run.startedAt?.toISOString() ?? null,
    completedAt: row.run.completedAt?.toISOString() ?? null,
    timeline: { ...timeline, status: row.run.status },
  };
}

/** Open tasks, and the 30 most recently finished. */
export async function listTasks(): Promise<TaskView[]> {
  const [open, done] = await Promise.all([
    db.select().from(tasks).where(ne(tasks.status, "done")).orderBy(asc(tasks.position)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "done"))
      .orderBy(desc(tasks.completedAt))
      .limit(30),
  ]);
  return [...open, ...done].map((task) => ({
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    ownerBotId: task.ownerBotId,
    dueOn: task.dueOn,
    position: task.position,
    createdBy: task.createdBy,
    createdByBotId: task.createdByBotId,
    chatId: task.chatId,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
  }));
}

export async function pendingProposal(botId: string): Promise<ProposalView | null> {
  const [row] = await db
    .select()
    .from(instructionProposals)
    .where(and(eq(instructionProposals.botId, botId), eq(instructionProposals.status, "pending")))
    .orderBy(desc(instructionProposals.createdAt))
    .limit(1);
  return row
    ? {
        id: row.id,
        current: row.current,
        proposed: row.proposed,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

export async function listLessons(botId: string): Promise<LessonView[]> {
  const rows = await db
    .select({ lesson: lessons, chatId: runs.chatId })
    .from(lessons)
    .leftJoin(runs, eq(runs.id, lessons.runId))
    .where(eq(lessons.botId, botId))
    .orderBy(desc(lessons.createdAt));
  return rows.map(({ lesson, chatId }) => ({
    id: lesson.id,
    text: lesson.text,
    createdAt: lesson.createdAt.toISOString(),
    runId: lesson.runId,
    chatId,
  }));
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
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listApprovals(): Promise<ApprovalView[]> {
  const rows = await db
    .select()
    .from(approvals)
    .orderBy(
      sql`case when ${approvals.status} = 'pending' then 0 else 1 end`,
      desc(approvals.createdAt),
    )
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    botId: row.botId,
    chatId: row.chatId,
    kind: row.kind,
    subject: typeof row.payload.subject === "string" ? row.payload.subject : null,
    askEveryTime: row.payload.askEveryTime === true,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  }));
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
      botId: row.botId,
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

export async function getProfile(): Promise<ProfileView> {
  const [row] = await db
    .select({ aboutMe: settings.aboutMe, updatedAt: settings.aboutMeUpdatedAt })
    .from(settings)
    .where(eq(settings.id, 1));
  return { aboutMe: row?.aboutMe ?? "", updatedAt: row?.updatedAt?.toISOString() ?? null };
}

export async function listTriggers(): Promise<TriggerView[]> {
  const rows = await db.select().from(triggers).orderBy(asc(triggers.createdAt));
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
      botId: row.botId,
      kind: row.kind,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled,
      createdBy: row.createdBy,
      url: row.url,
      intervalMinutes: row.intervalMinutes,
      lookFor: row.lookFor,
      hookPath: row.token ? `/api/hooks/${row.token}` : null,
      nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
      lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
      lastRun: last ? { id: last.id, status: last.status, chatId: last.chatId } : null,
    };
  });
}

/** The text around the first match, on one line, so a result shows why it matched. */
export function excerptAround(text: string, query: string, radius = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** Your messages and teammates' replies that contain the query, newest first. */
export async function searchMessages(query: string, limit = 12): Promise<SearchResultView[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [mine, replies] = await Promise.all([
    db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(eq(messages.role, "user"), ilike(messages.text, pattern), isNull(chats.archivedAt)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit),
    db
      .select({
        id: runs.id,
        chatId: runs.chatId,
        botId: runs.botId,
        text: runs.finalText,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(chats, eq(chats.id, runs.chatId))
      .where(
        and(ilike(runs.finalText, pattern), isNull(chats.archivedAt), ne(chats.kind, "helper")),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit),
  ]);
  return [
    ...mine.map((row) => ({
      id: row.id,
      from: "you" as const,
      chatId: row.chatId,
      runId: null,
      botId: null,
      excerpt: excerptAround(row.text, q),
      createdAt: row.createdAt.toISOString(),
    })),
    ...replies.map((row) => ({
      id: row.id,
      from: "bot" as const,
      chatId: row.chatId,
      runId: row.id,
      botId: row.botId,
      excerpt: excerptAround(plainText(row.text ?? ""), q),
      createdAt: row.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
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

export async function listActivity(limit = 12): Promise<ActivityView[]> {
  const rows = await db
    .select({ run: runs, chat: chats, prompt: runs.prompt })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .where(and(isNull(chats.archivedAt), ne(chats.kind, "helper")))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map(({ run, chat }) => ({
    runId: run.id,
    chatId: chat.id,
    chatKind: chat.kind,
    chatTitle: chat.title,
    botId: run.botId,
    trigger: run.trigger,
    status: run.status,
    preview: run.finalText ?? run.error ?? null,
    createdAt: run.createdAt.toISOString(),
  }));
}

/** Runs that finished since a time, newest first, for the "While you were away" briefing. */
export async function listFinishedSince(since: Date, limit = 60): Promise<BriefingItem[]> {
  const rows = await db
    .select({
      run: runs,
      chat: chats,
      scheduleTitle: schedules.title,
      scheduleQuiet: schedules.quiet,
      triggerTitle: triggers.title,
    })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .leftJoin(schedules, eq(schedules.id, runs.scheduleId))
    .leftJoin(triggers, eq(triggers.id, runs.triggerId))
    .where(
      and(
        isNull(chats.archivedAt),
        ne(chats.kind, "helper"),
        inArray(runs.status, ["completed", "failed"]),
        gte(runs.completedAt, since),
      ),
    )
    .orderBy(desc(runs.completedAt))
    .limit(limit);
  // A quiet routine that found nothing isn't news.
  const news = rows.filter(
    ({ run, scheduleQuiet }) => !(scheduleQuiet && isNothingToReport(run.finalText)),
  );
  return news.map(({ run, chat, scheduleTitle, triggerTitle }) => ({
    runId: run.id,
    chatId: chat.id,
    chatKind: chat.kind,
    chatTitle: chat.title,
    botId: run.botId,
    trigger: run.trigger,
    status: run.status,
    preview: run.finalText ?? run.error ?? null,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt!.toISOString(),
    automationTitle: scheduleTitle ?? triggerTitle ?? null,
  }));
}

/** The API key fallback: the key's hint, this month's spend and cap, and whether the plan ran out. */
export async function getModelAccess(): Promise<ModelAccessView> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  const [key] = await db
    .select({ hint: credentials.hint })
    .from(credentials)
    .where(eq(credentials.kind, "openai_api_key"));
  const [spend] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEntries.costMicros}), 0)` })
    .from(usageEntries)
    .where(and(eq(usageEntries.authMode, "api_key"), gte(usageEntries.createdAt, monthStart())));
  const limitedUntil =
    row?.planLimitedUntil && row.planLimitedUntil > new Date() ? row.planLimitedUntil : null;
  return {
    keyHint: key?.hint ?? null,
    capMicros: row?.monthlyCapMicros ?? 0,
    spendMicros: Number(spend?.total ?? 0),
    planLimitedUntil: limitedUntil?.toISOString() ?? null,
  };
}

/** Tokens each teammate used this month. */
export async function getMonthlyUsage(): Promise<UsageView[]> {
  const rows = await db
    .select({
      botId: usageEntries.botId,
      runs: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEntries.inputTokens}), 0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${usageEntries.cachedInputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEntries.outputTokens}), 0)::bigint`,
    })
    .from(usageEntries)
    .where(gte(usageEntries.createdAt, monthStart()))
    .groupBy(usageEntries.botId);
  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens),
  }));
}

/* ------------------------------------------------------------------ Vault */

export async function listVaultItems(): Promise<VaultItemView[]> {
  const rows = await db
    .select({
      id: vaultItems.id,
      kind: vaultItems.kind,
      name: vaultItems.name,
      domain: vaultItems.domain,
      hint: vaultItems.hint,
      botIds: vaultItems.botIds,
      lastUsedAt: vaultItems.lastUsedAt,
      updatedAt: vaultItems.updatedAt,
    })
    .from(vaultItems)
    .orderBy(asc(vaultItems.kind), asc(sql`lower(${vaultItems.name})`));
  return rows.map((row) => ({
    ...row,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Purchases that count against a budget: everything not denied or called off. */
const SPENDING = ["pending", "approved", "paid"] as const;

export async function getSpending(botId: string): Promise<SpendingView | null> {
  const [bot] = await db
    .select({ budget: bots.monthlyBudgetCents, autoApprove: bots.autoApproveCents })
    .from(bots)
    .where(eq(bots.id, botId));
  if (!bot) return null;
  const [rows, [spent]] = await Promise.all([
    db
      .select({
        purchase: purchases,
        cardName: vaultItems.name,
        cardHint: vaultItems.hint,
      })
      .from(purchases)
      .leftJoin(vaultItems, eq(vaultItems.id, purchases.cardId))
      .where(eq(purchases.botId, botId))
      .orderBy(desc(purchases.createdAt))
      .limit(50),
    db
      .select({ total: sql<number>`coalesce(sum(${purchases.amountCents}), 0)::int` })
      .from(purchases)
      .where(
        and(
          eq(purchases.botId, botId),
          inArray(purchases.status, [...SPENDING]),
          gte(purchases.createdAt, monthStart()),
        ),
      ),
  ]);
  return {
    budgetCents: bot.budget,
    autoApproveCents: bot.autoApprove,
    spentCents: spent?.total ?? 0,
    purchases: rows.map(({ purchase, cardName, cardHint }): PurchaseView => ({
      id: purchase.id,
      botId: purchase.botId,
      card: cardName ? `${cardName} (${cardHint})` : null,
      amountCents: purchase.amountCents,
      merchant: purchase.merchant,
      description: purchase.description,
      status: purchase.status,
      note: purchase.note,
      chatId: purchase.chatId,
      runId: purchase.runId,
      createdAt: purchase.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ Connections */

export async function listConnections(): Promise<ConnectionView[]> {
  const rows = await db
    .select()
    .from(connections)
    .orderBy(asc(sql`lower(${connections.label})`));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    name: row.name,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    secretNames: row.secretNames,
    botIds: row.botIds,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ Email */

/** The email settings row, made once with a fresh inbound secret. */
export async function emailSettingsRow() {
  const [row] = await db.select().from(emailSettings).where(eq(emailSettings.id, 1));
  if (row) return row;
  await db
    .insert(emailSettings)
    .values({ id: 1, inboundToken: randomBytes(18).toString("base64url") })
    .onConflictDoNothing();
  const [created] = await db.select().from(emailSettings).where(eq(emailSettings.id, 1));
  return created!;
}

export async function getEmailStatus(): Promise<EmailStatusView> {
  const settingsRow = await emailSettingsRow();
  const [credential] = await db
    .select({ hint: credentials.hint })
    .from(credentials)
    .where(eq(credentials.kind, "postmark_token"));
  const team = settingsRow.domain
    ? await db
        .select({ id: bots.id, name: bots.name, slug: bots.slug })
        .from(bots)
        .where(isNull(bots.archivedAt))
        .orderBy(asc(bots.createdAt))
    : [];
  return {
    domain: settingsRow.domain,
    inboundPath: `/api/inbound/email/${settingsRow.inboundToken}`,
    tokenHint: credential?.hint ?? null,
    lastReceivedAt: settingsRow.lastReceivedAt?.toISOString() ?? null,
    addresses: team.map((bot) => ({
      botId: bot.id,
      name: bot.name,
      address: emailAddress(bot.slug, settingsRow.domain!),
    })),
  };
}
