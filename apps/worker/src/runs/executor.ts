import {
  bots,
  chatMembers,
  chats,
  messageDispatches,
  messages,
  runs,
  settings,
} from "@open-bot/db";
import { COMPUTER_PATHS, emailAddress } from "@open-bot/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { announceRun, appendRunEvent, insertRun, publishApp, type Context } from "../context";
import { agentsMarkdown, allowedList, redoPrompt } from "../instructions";
import { errorMessage } from "../logger";
import type { ApprovalService } from "../services/approvals";
import type { SessionRegistry } from "../services/registry";
import type { ConnectionService } from "../services/connections";
import { emailSettingsRow } from "../services/email";
import type { SkillService } from "../services/skills";
import type { MemoryCoordinator } from "../services/memory";
import type { ModelAccess } from "../services/model-access";
import type { TakeoverService } from "../services/takeovers";
import type { ToolHandlers } from "../tools/handlers";
import { RunSession, type Bot, type Run } from "./session";

/** How long a saved message may wait for its dispatch before the worker dispatches it itself. */
export const DISPATCH_GRACE_MS = 15_000;

/** Claims queued runs and executes them, one at a time per bot per chat. */
export class RunExecutor {
  private pumping = false;
  private again = false;

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionRegistry,
    private readonly tools: ToolHandlers,
    private readonly approvals: ApprovalService,
    private readonly takeovers: TakeoverService,
    private readonly model: ModelAccess,
    private readonly skills: SkillService,
    private readonly connections: ConnectionService,
    private readonly memory: MemoryCoordinator,
  ) {}

  /** Runs that were executing when the worker stopped can't resume their turn. */
  async recover(): Promise<void> {
    const stale = await this.ctx.db
      .update(runs)
      .set({
        status: "interrupted",
        waitingFor: null,
        error: "The worker restarted while this was running.",
        completedAt: new Date(),
      })
      .where(inArray(runs.status, ["starting", "running", "waiting"]))
      .returning({ id: runs.id, chatId: runs.chatId, trigger: runs.trigger });
    for (const run of stale) {
      await appendRunEvent(this.ctx, run.id, run.chatId, {
        type: "status",
        status: "interrupted",
        error: "The worker restarted while this was running.",
      });
      await this.approvals.expireForRun(run.id);
      this.ctx.events.emit(
        "runFinished",
        run,
        "interrupted",
        null,
        "The worker restarted while this was running.",
      );
    }
    if (stale.length)
      this.ctx.log.warn(`marked ${stale.length} runs as interrupted after a restart`);
  }

  /** Start as many queued runs as allowed. Safe to call any time. */
  pump(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    void this.fill()
      .catch((error: unknown) =>
        this.ctx.log.error("run pump failed", { error: errorMessage(error) }),
      )
      .finally(() => {
        this.pumping = false;
        if (this.again) {
          this.again = false;
          this.pump();
        }
      });
  }

  private async fill() {
    while (this.sessions.size < this.ctx.env.MAX_CONCURRENT_RUNS) {
      const result = await this.ctx.db.execute<{ id: string }>(sql`
        update runs set status = 'starting'
        where id = (
          select r.id from runs r
          where r.status = 'queued'
            and not exists (
              select 1 from runs a
              where a.chat_id = r.chat_id and a.bot_id = r.bot_id
                and a.status in ('starting', 'running', 'waiting')
            )
          order by r.created_at
          limit 1
          for update skip locked
        )
        returning id`);
      const id = result.rows[0]?.id;
      if (!id) return;
      await this.start(id);
    }
  }

  private async start(runId: string) {
    const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return;
    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, run.botId));
    const [chat] = await this.ctx.db.select().from(chats).where(eq(chats.id, run.chatId));
    if (!bot || !chat || bot.archivedAt || run.cancelRequestedAt) {
      await this.ctx.db
        .update(runs)
        .set({ status: "interrupted", completedAt: new Date() })
        .where(eq(runs.id, runId));
      await appendRunEvent(this.ctx, run.id, run.chatId, { type: "status", status: "interrupted" });
      return;
    }
    const session = new RunSession(
      this.ctx,
      {
        tools: this.tools,
        requestNativeApproval: (s, input) => this.approvals.requestNative(s, input),
        buildPrompt: (s) => this.buildPrompt(s),
        skillInputs: (text, botId) => this.skills.inputsFor(text, botId),
        connections: (botId) => this.connections.forBot(botId),
        model: this.model,
        memory: this.memory,
        prepareWorkspace: () => this.syncWorkspace(bot),
      },
      run,
      bot,
      chat,
    );
    this.sessions.add(session);
    this.ctx.events.emit("runStarted", run);
    void (async () => {
      try {
        await session.execute();
      } finally {
        this.sessions.remove(run.id);
        this.approvals.releaseRun(run.id);
        this.takeovers.releaseRun(run.id);
        await this.approvals.expireForRun(run.id).catch(() => {});
        this.pump();
      }
    })();
  }

  /** Write the bot's AGENTS.md and skills, and a starter MEMORY.md if it has none. */
  async syncWorkspace(
    bot: Pick<Bot, "id" | "slug" | "name" | "role" | "instructions" | "autonomy">,
  ): Promise<string> {
    const client = await this.ctx.codex.ready();
    const workspace = COMPUTER_PATHS.workspace(bot.slug);
    const rules = await this.approvals.rulesFor(bot.id);

    const teammates = await this.ctx.db
      .select({ name: bots.name, role: bots.role })
      .from(bots)
      .where(and(isNull(bots.archivedAt), ne(bots.id, bot.id)))
      .orderBy(asc(bots.createdAt));
    const { labels: services } = await this.connections.forBot(bot.id);
    const { domain } = await emailSettingsRow(this.ctx);
    const address = domain ? emailAddress(bot.slug, domain) : null;
    await client.request("fs/createDirectory", { path: workspace, recursive: true });
    const instructions = agentsMarkdown(bot, rules, "", [], teammates, services, address);
    await client.request("fs/writeFile", {
      path: `${workspace}/AGENTS.md`,
      dataBase64: Buffer.from(instructions).toString("base64"),
    });
    await this.memory.prepare(bot);
    await this.skills.syncBot(bot);
    return instructions;
  }

  private async userTimeZone(): Promise<string> {
    const [row] = await this.ctx.db
      .select({ timezone: settings.timezone })
      .from(settings)
      .where(eq(settings.id, 1));
    return row?.timezone ?? "UTC";
  }

  private async buildPrompt(session: RunSession): Promise<string> {
    const { run, chat, bot } = session;
    const timeZone = await this.userTimeZone();
    const now = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    const lines = [`[Now: ${now} (${timeZone})]`];

    if (chat.kind === "group") {
      const members = await this.ctx.db
        .select({ id: bots.id, name: bots.name, role: bots.role })
        .from(chatMembers)
        .innerJoin(bots, eq(bots.id, chatMembers.botId))
        .where(and(eq(chatMembers.chatId, chat.id), isNull(bots.archivedAt)));
      const teammates = members.filter((member) => member.id !== bot.id);
      lines.push(
        `[Group chat "${chat.title}". Teammates here: ${teammates.map((t) => `${t.name} (${t.role})`).join(", ") || "none"}. Use handoff_to_bot when a teammate's job fits a request better.]`,
      );
      const recent = await this.recentGroupContext(run, bot.id);
      if (recent) lines.push(`[Since you last spoke in this chat:]\n${recent}`);
    }

    const memory = await this.memory.context(session);
    if (memory) lines.push(memory);

    // Rules you add mid-conversation reach a thread that already read its AGENTS.md.
    const allowed = allowedList(await this.approvals.rulesFor(bot.id));
    if (allowed)
      lines.push(`[The user always allows these without asking for approval:]\n${allowed}`);

    lines.push(run.prompt);
    if (run.attachments.length) {
      lines.push(
        `Attached files:\n${run.attachments.map((file) => `- ${file.path} (${file.mime}, ${Math.ceil(file.size / 1024)} KB)`).join("\n")}`,
      );
    }
    return lines.join("\n\n");
  }

  /** What the user and other bots said in a group chat since this bot's last run. */
  private async recentGroupContext(run: Run, botId: string): Promise<string | null> {
    const [last] = await this.ctx.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(and(eq(runs.chatId, run.chatId), eq(runs.botId, botId), ne(runs.id, run.id)))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    const since = last?.createdAt ?? new Date(0);
    const [userMessages, botReplies] = await Promise.all([
      this.ctx.db
        .select({ text: messages.text, createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, run.chatId),
            eq(messages.role, "user"),
            gt(messages.createdAt, since),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(10),
      this.ctx.db
        .select({ text: runs.finalText, createdAt: runs.completedAt, name: bots.name })
        .from(runs)
        .innerJoin(bots, eq(bots.id, runs.botId))
        .where(
          and(
            eq(runs.chatId, run.chatId),
            ne(runs.botId, botId),
            isNotNull(runs.finalText),
            gt(runs.createdAt, since),
          ),
        )
        .orderBy(asc(runs.completedAt))
        .limit(10),
    ]);
    const entries = [
      ...userMessages
        .filter((message) => message.id !== run.messageId)
        .map((message) => ({ at: message.createdAt, line: `User: ${message.text}` })),
      ...botReplies.map((reply) => ({
        at: reply.createdAt ?? new Date(),
        line: `${reply.name}: ${reply.text}`,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!entries.length) return null;
    return entries.map((entry) => entry.line.slice(0, 1500)).join("\n");
  }

  /**
   * Route a message you sent: join a bot's running turn, or start a run. Safe to call more than
   * once for the same message: each teammate is claimed in `message_dispatches` before it gets the
   * message, so it gets it once.
   */
  async dispatchMessage(messageId: string): Promise<void> {
    const [message] = await this.ctx.db.select().from(messages).where(eq(messages.id, messageId));
    if (!message) return;
    if (message.role !== "user") {
      await this.markDispatched(message.id);
      return;
    }
    const [chat] = await this.ctx.db.select().from(chats).where(eq(chats.id, message.chatId));
    if (!chat) return;

    if (
      message.dispatchStatus === "pending" &&
      message.feedbackRequest?.remember &&
      message.redoOfRunId
    ) {
      const [source] = await this.ctx.db
        .select({ botId: runs.botId })
        .from(runs)
        .where(eq(runs.id, message.redoOfRunId));
      if (!source) throw new Error("The reply this feedback belongs to is gone.");
      // Memory saving deduplicates the content in Postgres, including concurrent dispatches.
      // Keep the message pending until this succeeds so the reconciler can recover a crash.
      await this.memory.store.save(
        {
          botId: source.botId,
          kind: "lesson",
          content: message.feedbackRequest.text,
          key: null,
          pinned: true,
          expiresAt: null,
        },
        { kind: "user" },
        { source: { type: "feedback", runId: message.redoOfRunId } },
      );
    }

    let targets: string[];
    if (chat.kind === "group") {
      const members = await this.ctx.db
        .select({ id: bots.id, isPrimary: bots.isPrimary })
        .from(chatMembers)
        .innerJoin(bots, eq(bots.id, chatMembers.botId))
        .where(and(eq(chatMembers.chatId, chat.id), isNull(bots.archivedAt)))
        .orderBy(asc(chatMembers.createdAt));
      const memberIds = new Set(members.map((member) => member.id));
      const mentioned = message.mentions.filter((id) => memberIds.has(id));
      const lead = members.find((member) => member.isPrimary) ?? members[0];
      targets = mentioned.length ? mentioned : lead ? [lead.id] : [];
    } else {
      targets = chat.botId ? [chat.botId] : [];
    }
    const prompt = message.redoOfRunId ? redoPrompt(message.text) : message.text;

    let delivered = false;
    for (const botId of targets) {
      const session = this.sessions.find(chat.id, botId);
      if (session && message.attachments.length === 0) {
        // Claim the teammate before steering: a steer can't be undone or repeated safely.
        const [claimed] = await this.ctx.db
          .insert(messageDispatches)
          .values({ messageId: message.id, botId, kind: "steer", status: "sending" })
          .onConflictDoNothing()
          .returning({ botId: messageDispatches.botId });
        if (!claimed) continue;
        if (await session.steer(message.id, prompt)) {
          await this.ctx.db
            .update(messages)
            .set({ steeredRunId: session.run.id })
            .where(eq(messages.id, message.id));
          await this.ctx.db
            .update(messageDispatches)
            .set({ status: "done", runId: session.run.id })
            .where(
              and(eq(messageDispatches.messageId, message.id), eq(messageDispatches.botId, botId)),
            );
          delivered = true;
          continue;
        }
        // The turn ended or refused the steer: it becomes a run of its own.
        await this.queueRun(message, botId, prompt, { claimed: true });
        delivered = true;
        continue;
      }
      if (await this.queueRun(message, botId, prompt, { claimed: false })) delivered = true;
    }
    const first = await this.markDispatched(message.id);
    if (delivered || first) {
      await this.ctx.db
        .update(chats)
        .set({ lastActivityAt: new Date() })
        .where(eq(chats.id, chat.id));
      await publishApp(this.ctx, { type: "chats" });
    }
    this.pump();
  }

  /**
   * Queue the run that answers a message, in the same transaction as its dispatch record, so the
   * run exists if and only if the record does. False when another dispatch got there first.
   */
  private async queueRun(
    message: typeof messages.$inferSelect,
    botId: string,
    prompt: string,
    { claimed }: { claimed: boolean },
  ): Promise<boolean> {
    const runId = await this.ctx.db.transaction(async (tx) => {
      if (claimed) {
        const [row] = await tx
          .update(messageDispatches)
          .set({ kind: "run", status: "done" })
          .where(
            and(
              eq(messageDispatches.messageId, message.id),
              eq(messageDispatches.botId, botId),
              eq(messageDispatches.status, "sending"),
            ),
          )
          .returning({ botId: messageDispatches.botId });
        if (!row) return null;
      } else {
        const [row] = await tx
          .insert(messageDispatches)
          .values({ messageId: message.id, botId, kind: "run", status: "done" })
          .onConflictDoNothing()
          .returning({ botId: messageDispatches.botId });
        if (!row) return null;
      }
      const id = await insertRun(tx, {
        chatId: message.chatId,
        botId,
        trigger: "user",
        prompt,
        attachments: message.attachments,
        messageId: message.id,
      });
      await tx
        .update(messageDispatches)
        .set({ runId: id })
        .where(
          and(eq(messageDispatches.messageId, message.id), eq(messageDispatches.botId, botId)),
        );
      return id;
    });
    if (!runId) return false;
    await announceRun(this.ctx, message.chatId);
    return true;
  }

  /** True the first time, when the message was still pending. */
  private async markDispatched(messageId: string): Promise<boolean> {
    const rows = await this.ctx.db
      .update(messages)
      .set({ dispatchStatus: "dispatched" })
      .where(and(eq(messages.id, messageId), eq(messages.dispatchStatus, "pending")))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  /**
   * Steers that were being delivered when the worker stopped. The turn they joined ended with
   * that worker, so the message can't have been answered: it becomes a run of its own.
   * Call on startup, before anything can steer.
   */
  async recoverSteers(): Promise<void> {
    const rows = await this.ctx.db
      .select({ message: messages, botId: messageDispatches.botId })
      .from(messageDispatches)
      .innerJoin(messages, eq(messages.id, messageDispatches.messageId))
      .where(and(eq(messageDispatches.kind, "steer"), eq(messageDispatches.status, "sending")));
    for (const { message, botId } of rows) {
      const prompt = message.redoOfRunId ? redoPrompt(message.text) : message.text;
      await this.queueRun(message, botId, prompt, { claimed: true });
    }
    if (rows.length)
      this.ctx.log.warn(`queued ${rows.length} messages whose steer the restart interrupted`);
  }

  /** Dispatch messages that were saved but never dispatched, like after a crash in between. */
  async reconcileDispatches(olderThanMs = DISPATCH_GRACE_MS): Promise<void> {
    const stale = await this.ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.dispatchStatus, "pending"),
          lt(messages.createdAt, new Date(Date.now() - olderThanMs)),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(100);
    for (const { id } of stale) {
      try {
        await this.dispatchMessage(id);
      } catch (error) {
        this.ctx.log.error("dispatching a pending message failed", {
          messageId: id,
          error: errorMessage(error),
        });
      }
    }
    if (stale.length) this.ctx.log.warn(`dispatched ${stale.length} pending messages`);
  }

  /** Stop runs you cancelled: interrupt executing turns and drop queued ones. */
  async processCancellations(): Promise<void> {
    const cancelled = await this.ctx.db
      .select({ id: runs.id, chatId: runs.chatId, status: runs.status })
      .from(runs)
      .where(
        and(
          isNotNull(runs.cancelRequestedAt),
          inArray(runs.status, ["queued", "starting", "running", "waiting"]),
        ),
      );
    for (const run of cancelled) {
      const session = this.sessions.get(run.id);
      if (session) {
        await session.interrupt();
      } else if (run.status === "queued") {
        await this.ctx.db
          .update(runs)
          .set({ status: "interrupted", completedAt: new Date() })
          .where(and(eq(runs.id, run.id), eq(runs.status, "queued")));
        await appendRunEvent(this.ctx, run.id, run.chatId, {
          type: "status",
          status: "interrupted",
        });
      }
    }
  }
}
