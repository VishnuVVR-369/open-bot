"use server";

import {
  bots,
  CHANNELS,
  chatMembers,
  chats,
  messages,
  notifications,
  notify,
  runs,
  schedules,
  credentials,
  instructionProposals,
  lessons,
  settings,
  triggers,
  vaultItems,
  connections,
  emailSettings,
  type Attachment,
} from "@open-bot/db";
import {
  COMPUTER_PATHS,
  isValidTimeZone,
  MAX_ABOUT_ME_CHARS,
  MAX_LESSON_CHARS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  BOT_COLORS,
  DAILY_CHECK_IN,
  pickStarters,
  templateSkills,
  slugify,
  teammateBundleSchema,
  cardHint,
  connectionName,
  invalidCard,
  invalidMcpUrl,
  parseEnvLines,
  parseHeaderLines,
  normalizeDomain,
  normalizeExpiry,
  toCents,
  type CardSecret,
  type LoginSecret,
  type Autonomy,
  type EgressModeSetting,
} from "@open-bot/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret, secretHint } from "@open-bot/shared/secrets";
import { db, pool } from "./server/db";
import { serverEnv } from "./server/env";
import { requireUser } from "./server/session";
import { emailSettingsRow } from "./server/queries";
import { insertTeammateParts, teammateParts } from "./server/teammates";
import { worker } from "./server/worker";
import type { CodexStatusView, ConnectionTestView, MessageView, TelegramStatusView } from "./types";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function guarded<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  await requireUser();
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { ok: false, error: error.issues.map((i) => i.message).join(". ") };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function publish(type: string) {
  await notify(pool, CHANNELS.app, JSON.stringify({ type }));
}

/* ------------------------------------------------------------------ Bots */

const botInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your teammate a name.")
    .max(40, "Keep the name under 40 characters."),
  role: z.string().trim().min(1, "Describe their job in a few words.").max(80),
  instructions: z.string().max(8000).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  emoji: z.string().max(8).default(""),
  autonomy: z.enum(["full", "risky", "everything"]),
});

async function uniqueSlug(name: string, excludeId?: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (
      await db
        .select({ slug: bots.slug })
        .from(bots)
        .where(excludeId ? ne(bots.id, excludeId) : undefined)
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function userTimeZone(): Promise<string> {
  const [row] = await db
    .select({ timezone: settings.timezone })
    .from(settings)
    .where(eq(settings.id, 1));
  return row?.timezone ?? "UTC";
}

async function syncBot(botId: string) {
  // The workspace is written again before the bot's next run, so a stopped computer isn't fatal here.
  await worker("POST", `/internal/bots/${botId}/sync`).catch(() => {});
}

/** Creates a teammate, with the starter automations you kept from its template. */
export async function createBot(
  input: z.input<typeof botInput>,
  starters: { templateId: string | null; ids: string[] } = { templateId: null, ids: [] },
) {
  return guarded(async () => {
    const data = botInput.parse(input);
    const slug = await uniqueSlug(data.name);
    const existing = await db.select({ id: bots.id }).from(bots).where(isNull(bots.archivedAt));
    const [bot] = await db
      .insert(bots)
      .values({ ...data, slug, isPrimary: existing.length === 0 })
      .returning({ id: bots.id });
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: data.name, botId: bot!.id })
      .returning({ id: chats.id });
    await syncBot(bot!.id);
    await publish("bots");
    const picked = pickStarters(starters.templateId, starters.ids);
    let startersFailed = 0;
    if (picked.length > 0) {
      const timezone = await userTimeZone();
      for (const starter of picked) {
        // The teammate exists either way; a starter that didn't take can be added later.
        await worker("POST", "/internal/schedules", {
          botId: bot!.id,
          title: starter.title,
          prompt: starter.prompt,
          cron: starter.cron,
          at: null,
          timezone,
          quiet: starter.quiet ?? false,
        }).catch(() => (startersFailed += 1));
      }
    }
    // A template's skills become the teammate's own, so you can edit them.
    const skills = templateSkills(starters.templateId);
    let skillsFailed = 0;
    for (const skill of skills) {
      await worker("POST", "/internal/skills", { id: null, ...skill, botId: bot!.id }).catch(
        () => (skillsFailed += 1),
      );
    }
    if (skills.length) await publish("skills");
    return { botId: bot!.id, chatId: chat!.id, startersFailed, skillsFailed };
  });
}

export async function updateBot(botId: string, input: z.input<typeof botInput>) {
  return guarded(async () => {
    const data = botInput.parse(input);
    await db.update(bots).set(data).where(eq(bots.id, botId));
    await db
      .update(chats)
      .set({ title: data.name })
      .where(and(eq(chats.botId, botId), eq(chats.kind, "direct")));
    await syncBot(botId);
    await publish("bots");
  });
}

/**
 * A new teammate set up like another one: the same job, instructions and carefulness, their own
 * skills, what they may do without asking, and their schedules and page watches, paused so nothing
 * runs twice. Webhooks stay with the original, since services call their URLs. Chats stay with the
 * original too. Memory is copied when asked.
 */
export async function duplicateBot(botId: string, input: { name: string; copyMemory: boolean }) {
  return guarded(async () => {
    const name = botInput.shape.name.parse(input.name);
    const [source] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
    if (!source) throw new Error("That teammate no longer exists.");
    const slug = await uniqueSlug(name);
    const parts = await teammateParts(botId);
    const timezone = await userTimeZone();

    const created = await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(bots)
        .values({
          name,
          slug,
          role: source.role,
          instructions: source.instructions,
          color: source.color,
          emoji: source.emoji,
          autonomy: source.autonomy,
          isPrimary: false,
        })
        .returning({ id: bots.id });
      const [chat] = await tx
        .insert(chats)
        .values({ kind: "direct", title: name, botId: bot!.id })
        .returning({ id: chats.id });

      await insertTeammateParts(
        tx,
        bot!.id,
        // Lessons are learned, like memory, so they come along with it.
        { ...parts, lessons: input.copyMemory ? parts.lessons : [] },
        timezone,
      );
      // Reminders still to come are copied too, paused like the rest.
      const reminders = await tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.botId, botId), eq(schedules.kind, "once")));
      const upcoming = reminders.filter(
        (reminder) => (reminder.runAt?.getTime() ?? 0) > Date.now(),
      );
      if (upcoming.length > 0) {
        await tx.insert(schedules).values(
          upcoming.map((reminder) => ({
            botId: bot!.id,
            title: reminder.title,
            prompt: reminder.prompt,
            kind: "once" as const,
            runAt: reminder.runAt,
            nextRunAt: reminder.runAt,
            timezone: reminder.timezone,
            enabled: false,
            createdBy: "user" as const,
          })),
        );
      }
      return { botId: bot!.id, chatId: chat!.id };
    });

    // The workspace exists once it's synced, so the memory goes in after.
    await syncBot(created.botId);
    let memoryCopied = !input.copyMemory;
    if (input.copyMemory) {
      const memory = await readMemory(source.slug);
      memoryCopied = memory.ok && (await saveMemory(slug, memory.data)).ok;
    }
    await Promise.all([
      publish("bots"),
      publish("skills"),
      publish("schedules"),
      publish("triggers"),
    ]);
    return { ...created, memoryCopied };
  });
}

/**
 * A new teammate from an exported file. Its routines and page watches start paused; its chats,
 * memory notes and webhooks were never in the file.
 */
export async function importTeammate(file: string) {
  return guarded(async () => {
    let json: unknown;
    try {
      json = JSON.parse(file);
    } catch {
      throw new Error("This isn't an open-bot teammate file.");
    }
    const parsed = teammateBundleSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        issue?.path.length
          ? `The file has a problem at ${issue.path.join(".")}: ${issue.message}`
          : (issue?.message ?? "The file couldn't be read."),
      );
    }
    const { teammate, ...parts } = parsed.data;
    const used = new Set(
      (await db.select({ color: bots.color }).from(bots).where(isNull(bots.archivedAt))).map(
        (row) => row.color,
      ),
    );
    const color =
      teammate.color ?? BOT_COLORS.find((candidate) => !used.has(candidate)) ?? BOT_COLORS[0]!;
    const slug = await uniqueSlug(teammate.name);
    const timezone = await userTimeZone();
    const existing = await db.select({ id: bots.id }).from(bots).where(isNull(bots.archivedAt));

    const created = await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(bots)
        .values({
          name: teammate.name,
          slug,
          role: teammate.role,
          instructions: teammate.instructions,
          color,
          emoji: teammate.emoji,
          autonomy: teammate.autonomy,
          isPrimary: existing.length === 0,
        })
        .returning({ id: bots.id });
      const [chat] = await tx
        .insert(chats)
        .values({ kind: "direct", title: teammate.name, botId: bot!.id })
        .returning({ id: chats.id });
      await insertTeammateParts(tx, bot!.id, parts, timezone);
      return { botId: bot!.id, chatId: chat!.id };
    });
    await syncBot(created.botId);
    await Promise.all([
      publish("bots"),
      publish("skills"),
      publish("schedules"),
      publish("triggers"),
      publish("lessons"),
    ]);
    return {
      ...created,
      name: teammate.name,
      paused: parts.routines.length + parts.watches.length,
    };
  });
}

export async function setPrimaryBot(botId: string) {
  return guarded(async () => {
    await db.update(bots).set({ isPrimary: false }).where(ne(bots.id, botId));
    await db.update(bots).set({ isPrimary: true }).where(eq(bots.id, botId));
    await publish("bots");
  });
}

export async function archiveBot(botId: string) {
  return guarded(async () => {
    const now = new Date();
    await db.update(bots).set({ archivedAt: now, isPrimary: false }).where(eq(bots.id, botId));
    await db
      .update(chats)
      .set({ archivedAt: now })
      .where(and(eq(chats.botId, botId), isNull(chats.archivedAt)));
    await db.update(schedules).set({ enabled: false }).where(eq(schedules.botId, botId));
    await db.update(triggers).set({ enabled: false }).where(eq(triggers.botId, botId));
    await db
      .update(runs)
      .set({ cancelRequestedAt: now })
      .where(
        and(
          eq(runs.botId, botId),
          inArray(runs.status, ["queued", "starting", "running", "waiting"]),
        ),
      );
    await notify(pool, CHANNELS.worker, "cancel");
    // Their screen stops and its browser history goes; sign-ins stay shared with the other screens.
    await worker("POST", `/internal/screens/${botId}/forget`).catch(() => {});
    await publish("bots");
  });
}

export async function readMemory(slug: string) {
  return guarded(async () => {
    const { dataBase64 } = await worker<{ dataBase64: string }>(
      "GET",
      `/internal/files/read?path=${encodeURIComponent(`${COMPUTER_PATHS.workspace(slug)}/MEMORY.md`)}`,
    );
    return Buffer.from(dataBase64, "base64").toString("utf8");
  });
}

export async function saveMemory(slug: string, text: string) {
  return guarded(async () => {
    await worker("POST", "/internal/files/write", {
      path: `${COMPUTER_PATHS.workspace(slug)}/MEMORY.md`,
      dataBase64: Buffer.from(text).toString("base64"),
    });
  });
}

/* ------------------------------------------------------------------ Chats and messages */

export async function newDirectChat(botId: string) {
  return guarded(async () => {
    const [bot] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error("That teammate no longer exists.");
    const [chat] = await db
      .insert(chats)
      .values({ kind: "direct", title: bot.name, botId })
      .returning({ id: chats.id });
    await publish("chats");
    return { chatId: chat!.id };
  });
}

export async function createGroupChat(input: { title: string; botIds: string[] }) {
  return guarded(async () => {
    const data = z
      .object({
        title: z.string().trim().min(1, "Name the group.").max(60),
        botIds: z.array(z.string().uuid()).min(2, "Pick at least two teammates."),
      })
      .parse(input);
    const [chat] = await db
      .insert(chats)
      .values({ kind: "group", title: data.title })
      .returning({ id: chats.id });
    await db.insert(chatMembers).values(data.botIds.map((botId) => ({ chatId: chat!.id, botId })));
    await publish("chats");
    return { chatId: chat!.id };
  });
}

export async function renameChat(chatId: string, title: string) {
  return guarded(async () => {
    const value = z.string().trim().min(1).max(60).parse(title);
    await db.update(chats).set({ title: value }).where(eq(chats.id, chatId));
    await publish("chats");
  });
}

export async function archiveChat(chatId: string) {
  return guarded(async () => {
    await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, chatId));
    await publish("chats");
  });
}

export async function sendMessage(input: {
  chatId: string;
  text: string;
  attachments: Attachment[];
  mentions: string[];
}): Promise<ActionResult<MessageView>> {
  return guarded(async () => {
    const text = input.text.trim();
    if (!text && input.attachments.length === 0) throw new Error("Write a message first.");
    const [row] = await db
      .insert(messages)
      .values({
        chatId: input.chatId,
        role: "user",
        text: text || "(See the attached files.)",
        attachments: input.attachments,
        mentions: input.mentions,
      })
      .returning();
    await worker("POST", `/internal/messages/${row!.id}/dispatch`);
    return {
      id: row!.id,
      role: "user",
      text: row!.text,
      attachments: row!.attachments,
      mentions: row!.mentions,
      steeredRunId: null,
      redoOfRunId: null,
      createdAt: row!.createdAt.toISOString(),
    };
  });
}

export async function uploadAttachment(form: FormData): Promise<ActionResult<Attachment>> {
  return guarded(async () => {
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file was attached.");
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Files can be up to ${MAX_UPLOAD_LABEL}.`);
    const dataBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const { path, size } = await worker<{ path: string; size: number }>(
      "POST",
      "/internal/files/upload",
      { name: file.name, mime: file.type || "application/octet-stream", dataBase64 },
      120_000,
    );
    return { name: file.name, path, mime: file.type || "application/octet-stream", size };
  });
}

/** Put a file you picked into a folder on the computer. A taken name gets a number. */
export async function uploadFile(dir: string, form: FormData): Promise<ActionResult<string>> {
  return guarded(async () => {
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("No file was attached.");
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Files can be up to ${MAX_UPLOAD_LABEL}.`);
    const { path } = await worker<{ path: string }>(
      "POST",
      "/internal/files/put",
      {
        dir,
        name: file.name,
        dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      },
      120_000,
    );
    return path;
  });
}

export async function removeFile(path: string) {
  return guarded(async () => {
    await worker("POST", "/internal/files/remove", { path });
  });
}

/** Run a failed or stopped request again. */
export async function retryRun(runId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/runs/${runId}/retry`);
  });
}

/** Stop every helper in a swarm. The teammate doesn't get their results. */
export async function stopSwarm(swarmId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/swarms/${z.string().uuid().parse(swarmId)}/stop`);
  });
}

export async function cancelRun(runId: string) {
  return guarded(async () => {
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, runId));
    await worker("POST", "/internal/runs/cancel");
  });
}

/* ------------------------------------------------------------------ Feedback */

const runId = z.string().uuid("That reply is gone.");

export async function rateRun(id: string, rating: "up" | "down" | null) {
  return guarded(async () => {
    await db
      .update(runs)
      .set({ rating: z.enum(["up", "down"]).nullable().parse(rating) })
      .where(eq(runs.id, runId.parse(id)));
  });
}

/**
 * A thumbs down with what to change. Saved as a lesson, the teammate reads it before every task;
 * with `redo`, it's also sent to the chat so the teammate tries again now.
 */
export async function giveFeedback(input: {
  runId: string;
  text: string;
  remember: boolean;
  redo: boolean;
}) {
  return guarded(async () => {
    const text = z
      .string()
      .trim()
      .min(1, "Say what to do differently.")
      .max(MAX_LESSON_CHARS, `Keep it under ${MAX_LESSON_CHARS} characters.`)
      .parse(input.text);
    const [run] = await db
      .select({ id: runs.id, botId: runs.botId, chatId: runs.chatId, botName: bots.name })
      .from(runs)
      .innerJoin(bots, eq(bots.id, runs.botId))
      .where(eq(runs.id, runId.parse(input.runId)));
    if (!run) throw new Error("That reply is gone.");
    await db.transaction(async (tx) => {
      await tx.update(runs).set({ rating: "down" }).where(eq(runs.id, run.id));
      if (!input.remember) return;
      await tx.insert(lessons).values({ botId: run.botId, runId: run.id, text });
      await tx.update(bots).set({ lessonsChangedAt: new Date() }).where(eq(bots.id, run.botId));
    });
    if (input.remember) await publish("lessons");
    if (!input.redo) return;
    const [chat] = await db
      .select({ kind: chats.kind })
      .from(chats)
      .where(eq(chats.id, run.chatId));
    const group = chat?.kind === "group";
    const [message] = await db
      .insert(messages)
      .values({
        chatId: run.chatId,
        role: "user",
        // In a group, the message goes to the teammate who replied.
        text: group ? `@${run.botName} ${text}` : text,
        mentions: group ? [run.botId] : [],
        redoOfRunId: run.id,
      })
      .returning({ id: messages.id });
    await worker("POST", `/internal/messages/${message!.id}/dispatch`);
  });
}

export async function deleteLesson(id: string) {
  return guarded(async () => {
    const [lesson] = await db
      .delete(lessons)
      .where(eq(lessons.id, z.string().uuid().parse(id)))
      .returning({ botId: lessons.botId });
    if (!lesson) return;
    await db.update(bots).set({ lessonsChangedAt: new Date() }).where(eq(bots.id, lesson.botId));
    await publish("lessons");
  });
}

/* ------------------------------------------------------------------ Suggested instructions */

/** Takes a teammate's suggested instructions; they apply from its next message. */
export async function acceptProposal(proposalId: string) {
  return guarded(async () => {
    const botId = await db.transaction(async (tx) => {
      const [proposal] = await tx
        .update(instructionProposals)
        .set({ status: "accepted", decidedAt: new Date() })
        .where(
          and(
            eq(instructionProposals.id, z.string().uuid().parse(proposalId)),
            eq(instructionProposals.status, "pending"),
          ),
        )
        .returning();
      if (!proposal) throw new Error("That suggestion was already handled.");
      await tx
        .update(bots)
        .set({ instructions: proposal.proposed })
        .where(eq(bots.id, proposal.botId));
      return proposal.botId;
    });
    await syncBot(botId);
    await publish("bots");
  });
}

export async function dismissProposal(proposalId: string) {
  return guarded(async () => {
    await db
      .update(instructionProposals)
      .set({ status: "dismissed", decidedAt: new Date() })
      .where(
        and(
          eq(instructionProposals.id, z.string().uuid().parse(proposalId)),
          eq(instructionProposals.status, "pending"),
        ),
      );
    await publish("bots");
  });
}

/* ------------------------------------------------------------------ Tasks */

export async function createTask(input: {
  title: string;
  notes?: string;
  ownerBotId?: string | null;
  dueOn?: string | null;
}) {
  return guarded(async () => worker<{ id: string }>("POST", "/internal/tasks", input));
}

export async function updateTask(
  taskId: string,
  patch: {
    title?: string;
    notes?: string;
    status?: "todo" | "doing" | "done";
    ownerBotId?: string | null;
    dueOn?: string | null;
    position?: number;
  },
) {
  return guarded(async () => {
    await worker("POST", `/internal/tasks/${taskId}`, patch);
  });
}

export async function deleteTask(taskId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/tasks/${taskId}/delete`);
  });
}

/** Asks the task's owner to work on it now. */
export async function startTask(taskId: string) {
  return guarded(async () =>
    worker<{ chatId: string | null }>("POST", `/internal/tasks/${taskId}/start`),
  );
}

/* ------------------------------------------------------------------ Approvals and screens */

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "denied",
  alwaysAllow: { pattern: string } | null = null,
) {
  return guarded(async () => {
    const result = await worker<{ decided: boolean }>(
      "POST",
      `/internal/approvals/${approvalId}/decide`,
      { decision, alwaysAllow },
    );
    if (!result.decided) throw new Error("This was already decided.");
  });
}

export async function removeApprovalRule(ruleId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/approval-rules/${ruleId}/delete`);
  });
}

export async function takeOverScreen(screenId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/screens/${screenId}/take`);
  });
}

export async function handBackScreen(screenId: string, note: string | null) {
  return guarded(async () => {
    await worker("POST", `/internal/screens/${screenId}/hand-back`, { note });
  });
}

export async function wakeScreen(screenId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/screens/${screenId}/wake`, undefined, 60_000);
  });
}

export async function dismissTakeoverRequest(takeoverId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/takeover/${takeoverId}/dismiss`);
  });
}

export async function reportScreenActivity(screenId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/screens/${screenId}/touch`);
  });
}

/* ------------------------------------------------------------------ Vault */

const vaultInput = z.object({
  id: z.string().uuid().nullable(),
  kind: z.enum(["login", "card"]),
  name: z.string().trim().min(1, "Give it a name.").max(80),
  domain: z.string().max(300).default(""),
  /** The teammates that may use it, or null for every teammate. */
  botIds: z.array(z.string().uuid()).nullable(),
  /** Fields left empty when editing keep what's saved. */
  secret: z.record(z.string(), z.string().max(500)),
});

/** Save a login or card. Secrets are encrypted here and never sent back to the browser. */
export async function saveVaultItem(input: z.input<typeof vaultInput>) {
  return guarded(async () => {
    const data = vaultInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    const [existing] = data.id
      ? await db.select().from(vaultItems).where(eq(vaultItems.id, data.id))
      : [];
    if (data.id && !existing) throw new Error("That item is no longer in the vault.");
    if (existing && existing.kind !== data.kind) throw new Error("An item can't change its kind.");
    const saved = existing
      ? (JSON.parse(decryptSecret(existing.encrypted, serverEnv.encryptionKey)) as Record<
          string,
          string
        >)
      : {};
    const merged: Record<string, string> = { ...saved };
    for (const [field, value] of Object.entries(data.secret))
      if (value.trim()) merged[field] = value;

    let secret: LoginSecret | CardSecret;
    let hint: string;
    let domain: string | null = null;
    if (data.kind === "login") {
      domain = normalizeDomain(data.domain);
      if (!domain) throw new Error("Give the site it's for, like github.com.");
      const username = (data.secret.username ?? merged.username ?? "").trim();
      const password = merged.password ?? "";
      if (!username) throw new Error("Add the username or email.");
      if (!password) throw new Error("Add the password.");
      secret = { username, password };
      hint = username;
    } else {
      const card: CardSecret = {
        number: (merged.number ?? "").replace(/[\s-]/g, ""),
        expiry: normalizeExpiry(merged.expiry ?? "") ?? merged.expiry ?? "",
        cvc: (merged.cvc ?? "").trim(),
        name: (merged.name ?? "").trim(),
        zip: (merged.zip ?? "").trim(),
      };
      const problem = invalidCard(card);
      if (problem) throw new Error(problem);
      secret = card;
      hint = cardHint(card.number);
    }
    const values = {
      kind: data.kind,
      name: data.name,
      domain,
      hint,
      botIds: data.botIds,
      encrypted: encryptSecret(JSON.stringify(secret), serverEnv.encryptionKey),
    };
    if (existing) await db.update(vaultItems).set(values).where(eq(vaultItems.id, existing.id));
    else await db.insert(vaultItems).values(values);
    await publish("vault");
  });
}

export async function deleteVaultItem(id: string) {
  return guarded(async () => {
    await db.delete(vaultItems).where(eq(vaultItems.id, z.string().uuid().parse(id)));
    await publish("vault");
  });
}

/** A teammate's monthly budget, in dollars, or null so it can't pay at all. */
export async function setBudget(
  botId: string,
  input: { budget: number | null; autoApprove: number },
) {
  return guarded(async () => {
    const budgetCents = input.budget === null ? null : toCents(input.budget);
    if (input.budget !== null && budgetCents === null)
      throw new Error("Give the budget in dollars, like 100.");
    if (budgetCents !== null && budgetCents > 10_000_000)
      throw new Error("Keep the budget under $100,000.");
    const autoApproveCents = input.autoApprove > 0 ? (toCents(input.autoApprove) ?? 0) : 0;
    if (budgetCents !== null && autoApproveCents > budgetCents)
      throw new Error("The amount to approve on its own can't be more than the budget.");
    await db
      .update(bots)
      .set({ monthlyBudgetCents: budgetCents, autoApproveCents })
      .where(eq(bots.id, z.string().uuid().parse(botId)));
    await publish("purchases");
  });
}

/* ------------------------------------------------------------------ Email */

/**
 * Your teammates' email: the domain their addresses are on, and Postmark's server token, which
 * sends what they write. A token left empty keeps the saved one.
 */
export async function saveEmailSettings(input: { domain: string; token: string }) {
  return guarded(async () => {
    const domain = input.domain.trim() ? normalizeDomain(input.domain) : null;
    if (input.domain.trim() && !domain) throw new Error("Give a domain, like team.example.com.");
    await emailSettingsRow();
    await db.update(emailSettings).set({ domain }).where(eq(emailSettings.id, 1));
    const token = input.token.trim();
    if (token) {
      if (!/^[\w-]{20,80}$/.test(token))
        throw new Error("That doesn't look like a Postmark server token.");
      const encrypted = encryptSecret(token, serverEnv.encryptionKey);
      await db
        .insert(credentials)
        .values({ kind: "postmark_token", encrypted, hint: secretHint(token) })
        .onConflictDoUpdate({
          target: credentials.kind,
          set: { encrypted, hint: secretHint(token) },
        });
    }
    await publish("email");
    // Teammates learn their address in their instructions.
    for (const bot of await db.select({ id: bots.id }).from(bots).where(isNull(bots.archivedAt)))
      await syncBot(bot.id).catch(() => {});
  });
}

export async function removeEmailToken() {
  return guarded(async () => {
    await db.delete(credentials).where(eq(credentials.kind, "postmark_token"));
    await publish("email");
  });
}

/* ------------------------------------------------------------------ Connections */

const connectionInput = z.object({
  id: z.string().uuid().nullable(),
  label: z.string().trim().min(1, "Give it a name.").max(60),
  transport: z.enum(["http", "stdio"]),
  url: z.string().trim().max(2000).default(""),
  command: z.string().trim().max(500).default(""),
  args: z.string().max(4000).default(""),
  /** Header lines (http) or NAME=value lines (stdio). Empty when editing keeps what's saved. */
  secrets: z.string().max(20_000).default(""),
  botIds: z.array(z.string().uuid()).nullable(),
});

/** Save a service teammates use through MCP. Headers and variables are encrypted here. */
export async function saveConnection(input: z.input<typeof connectionInput>) {
  return guarded(async () => {
    const data = connectionInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    if (data.transport === "http") {
      const problem = invalidMcpUrl(data.url);
      if (problem) throw new Error(problem);
    } else if (!data.command) throw new Error("Give the command the computer runs.");
    const parsed = data.secrets.trim()
      ? data.transport === "http"
        ? parseHeaderLines(data.secrets)
        : parseEnvLines(data.secrets)
      : null;
    if (typeof parsed === "string") throw new Error(parsed);
    const [existing] = data.id
      ? await db.select().from(connections).where(eq(connections.id, data.id))
      : [];
    if (data.id && !existing) throw new Error("That connection is gone.");
    const name = existing?.name ?? (await uniqueConnectionName(connectionName(data.label)));
    // Without new secrets, an edit keeps the saved ones, unless the kind of connection changed.
    const keep = !parsed && existing && existing.transport === data.transport;
    const secrets = parsed
      ? data.transport === "http"
        ? { headers: parsed }
        : { env: parsed }
      : null;
    const values = {
      label: data.label,
      name,
      transport: data.transport,
      url: data.transport === "http" ? data.url : null,
      command: data.transport === "stdio" ? data.command : null,
      args: data.transport === "stdio" ? splitArgs(data.args) : [],
      botIds: data.botIds,
      ...(keep
        ? {}
        : {
            encrypted: secrets
              ? encryptSecret(JSON.stringify(secrets), serverEnv.encryptionKey)
              : null,
            secretNames: parsed ? Object.keys(parsed) : [],
          }),
    };
    const [row] = existing
      ? await db.update(connections).set(values).where(eq(connections.id, existing.id)).returning()
      : await db.insert(connections).values(values).returning();
    await publish("connections");
    return { id: row!.id };
  });
}

/** "a b 'c d'" as arguments, keeping quoted ones together. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

async function uniqueConnectionName(base: string): Promise<string> {
  const taken = new Set(
    (await db.select({ name: connections.name }).from(connections)).map((row) => row.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

export async function setConnectionEnabled(id: string, enabled: boolean) {
  return guarded(async () => {
    await db
      .update(connections)
      .set({ enabled })
      .where(eq(connections.id, z.string().uuid().parse(id)));
    await publish("connections");
  });
}

export async function deleteConnection(id: string) {
  return guarded(async () => {
    await db.delete(connections).where(eq(connections.id, z.string().uuid().parse(id)));
    await publish("connections");
  });
}

/** Connect to the service from the computer, and list what it offers. */
export async function testConnection(id: string) {
  return guarded(async () =>
    worker<ConnectionTestView>(
      "POST",
      `/internal/connections/${z.string().uuid().parse(id)}/test`,
      undefined,
      90_000,
    ),
  );
}

/* ------------------------------------------------------------------ Skills */

export async function saveSkill(input: {
  id: string | null;
  name: string;
  description: string;
  instructions: string;
  botId: string | null;
}) {
  return guarded(async () => worker<{ id: string }>("POST", "/internal/skills", input));
}

export async function deleteSkill(skillId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/skills/${skillId}/delete`);
  });
}

/* ------------------------------------------------------------------ Schedules */

export async function createSchedule(input: {
  botId: string;
  title: string;
  prompt: string;
  cron: string | null;
  at: string | null;
  timezone: string;
  quiet?: boolean;
}) {
  return guarded(async () => worker<{ id: string }>("POST", "/internal/schedules", input));
}

export async function updateSchedule(
  scheduleId: string,
  input: {
    botId: string;
    title: string;
    prompt: string;
    cron: string | null;
    at: string | null;
    timezone: string;
    quiet?: boolean;
  },
) {
  return guarded(async () =>
    worker<{ id: string }>("POST", `/internal/schedules/${scheduleId}`, input),
  );
}

export async function setScheduleEnabled(scheduleId: string, enabled: boolean) {
  return guarded(async () => {
    await worker("POST", `/internal/schedules/${scheduleId}/enabled`, { enabled });
  });
}

export async function deleteSchedule(scheduleId: string) {
  return guarded(async () => {
    await db.delete(schedules).where(eq(schedules.id, scheduleId));
    await publish("schedules");
  });
}

/**
 * Turn a teammate's daily check-in on or off: every morning it looks over its area and tells you
 * only what needs you. Turning it on resumes a paused one rather than adding another.
 */
export async function setCheckIn(botId: string, on: boolean) {
  return guarded(async () => {
    const id = z.string().uuid().parse(botId);
    const existing = await db
      .select({ id: schedules.id, enabled: schedules.enabled })
      .from(schedules)
      .where(
        and(
          eq(schedules.botId, id),
          eq(schedules.title, DAILY_CHECK_IN.title),
          eq(schedules.quiet, true),
        ),
      );
    if (!on) {
      for (const row of existing)
        await worker("POST", `/internal/schedules/${row.id}/enabled`, { enabled: false });
      return;
    }
    if (existing[0]) {
      await worker("POST", `/internal/schedules/${existing[0].id}/enabled`, { enabled: true });
      return;
    }
    await worker("POST", "/internal/schedules", {
      botId: id,
      title: DAILY_CHECK_IN.title,
      prompt: DAILY_CHECK_IN.prompt,
      cron: DAILY_CHECK_IN.cron,
      at: null,
      timezone: await userTimeZone(),
      quiet: true,
    });
  });
}

export async function runScheduleNow(scheduleId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/schedules/${scheduleId}/run`);
  });
}

/* ------------------------------------------------------------------ Watches and webhooks */

export interface TriggerInput {
  botId: string;
  kind: "watch" | "webhook";
  title: string;
  prompt: string;
  url?: string | null;
  intervalMinutes?: number | null;
  lookFor?: string | null;
}

export async function createTrigger(input: TriggerInput) {
  return guarded(async () =>
    worker<{ id: string; hookPath: string | null }>("POST", "/internal/triggers", input),
  );
}

export async function updateTrigger(triggerId: string, input: TriggerInput) {
  return guarded(async () =>
    worker<{ id: string }>("POST", `/internal/triggers/${triggerId}`, input),
  );
}

export async function setTriggerEnabled(triggerId: string, enabled: boolean) {
  return guarded(async () => {
    await worker("POST", `/internal/triggers/${triggerId}/enabled`, { enabled });
  });
}

export async function deleteTrigger(triggerId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/triggers/${triggerId}/delete`);
  });
}

/** Check a watched page now. */
export async function checkTriggerNow(triggerId: string) {
  return guarded(async () =>
    worker<{ ok: boolean; changed: boolean; summary: string }>(
      "POST",
      `/internal/triggers/${triggerId}/check`,
      undefined,
      45_000,
    ),
  );
}

/** Give a webhook a new URL. The old one stops working. */
export async function rotateWebhook(triggerId: string) {
  return guarded(async () => {
    await worker("POST", `/internal/triggers/${triggerId}/rotate`);
  });
}

/** Call a webhook with a sample request, as a service would. */
export async function testWebhook(triggerId: string) {
  return guarded(async () => {
    const [row] = await db.select().from(triggers).where(eq(triggers.id, triggerId));
    if (!row?.token) throw new Error("That webhook no longer exists.");
    return worker<{ runId: string }>("POST", `/internal/hooks/${row.token}`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ test: true, message: "A test request from the open-bot app" }),
      query: "",
    });
  });
}

/* ------------------------------------------------------------------ Your profile */

/** Save what every teammate knows about you. */
export async function saveProfile(text: string) {
  return guarded(async () => {
    const aboutMe = z
      .string()
      .max(MAX_ABOUT_ME_CHARS, `Keep it under ${MAX_ABOUT_ME_CHARS} characters.`)
      .parse(text.replace(/\s+$/, ""));
    await db
      .update(settings)
      .set({ aboutMe, aboutMeUpdatedAt: new Date() })
      .where(eq(settings.id, 1));
    await publish("profile");
  });
}

/* ------------------------------------------------------------------ Telegram */

export async function connectTelegram(token: string) {
  return guarded(async () =>
    worker<TelegramStatusView>("POST", "/internal/telegram/connect", { token }),
  );
}

export async function telegramLinkCode() {
  return guarded(async () =>
    worker<{ code: string; url: string; expiresAt: string }>(
      "POST",
      "/internal/telegram/link-code",
    ),
  );
}

export async function sendTelegramTest() {
  return guarded(async () => {
    await worker("POST", "/internal/telegram/test");
  });
}

export async function unlinkTelegram() {
  return guarded(async () => {
    await worker("POST", "/internal/telegram/unlink");
  });
}

export async function disconnectTelegram() {
  return guarded(async () => {
    await worker("POST", "/internal/telegram/disconnect");
  });
}

/* ------------------------------------------------------------------ Push notifications */

export async function subscribePush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  device: string,
) {
  return guarded(async () => {
    await worker("POST", "/internal/push/subscribe", { subscription, device });
  });
}

export async function unsubscribePush(endpoint: string) {
  return guarded(async () => {
    await worker("POST", "/internal/push/unsubscribe", { endpoint });
  });
}

export async function sendPushTest() {
  return guarded(async () => worker<{ sent: number }>("POST", "/internal/push/test"));
}

/* ------------------------------------------------------------------ Notifications */

export async function markNotificationsRead(ids?: string[]) {
  return guarded(async () => {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(isNull(notifications.readAt), ids?.length ? inArray(notifications.id, ids) : undefined),
      );
    await publish("notification");
  });
}

/* ------------------------------------------------------------------ Settings */

export async function setEgressMode(mode: EgressModeSetting) {
  return guarded(async () => {
    await worker("POST", "/internal/egress/mode", {
      mode: z.enum(["off", "prefer", "require"]).parse(mode),
    });
  });
}

export async function setTimezone(timezone: string) {
  return guarded(async () => {
    if (!isValidTimeZone(timezone)) throw new Error("Unknown timezone.");
    await db.update(settings).set({ timezone }).where(eq(settings.id, 1));
  });
}

export async function getSettings() {
  return guarded(async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    return { timezone: row?.timezone ?? "UTC", monthlyCapMicros: row?.monthlyCapMicros ?? 0 };
  });
}

export async function setChatgptAuthSource(source: "device" | "host") {
  return guarded(async () =>
    worker<CodexStatusView>("POST", "/internal/codex/auth-source", { source }),
  );
}

export async function startChatgptLogin() {
  return guarded(async () =>
    worker<{ verificationUrl: string; userCode: string }>("POST", "/internal/codex/device-login"),
  );
}

export async function signOutChatgpt() {
  return guarded(async () => {
    await worker("POST", "/internal/codex/logout");
  });
}

/* ------------------------------------------------------------------ When the plan runs out */

export async function saveApiKey(apiKey: string) {
  return guarded(async () => {
    const key = z
      .string()
      .trim()
      .regex(
        /^sk-[A-Za-z0-9_-]{20,}$/,
        "That doesn't look like an OpenAI API key. It starts with sk-.",
      )
      .parse(apiKey);
    const encrypted = encryptSecret(key, serverEnv.encryptionKey);
    await db
      .insert(credentials)
      .values({ kind: "openai_api_key", encrypted, hint: secretHint(key) })
      .onConflictDoUpdate({ target: credentials.kind, set: { encrypted, hint: secretHint(key) } });
    await publish("auth");
  });
}

export async function removeApiKey() {
  return guarded(async () => {
    await db.delete(credentials).where(eq(credentials.kind, "openai_api_key"));
    await publish("auth");
  });
}

export async function setMonthlyCap(dollars: number) {
  return guarded(async () => {
    const value = z.number().min(0, "The cap can't be negative.").max(10_000).parse(dollars);
    await db
      .update(settings)
      .set({ monthlyCapMicros: Math.round(value * 1_000_000) })
      .where(eq(settings.id, 1));
    await publish("auth");
  });
}

/** Tokens per teammate since the start of this month. */
export type { Autonomy };
