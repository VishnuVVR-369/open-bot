import type { CodexClient, ServerNotification, ServerRequest, v2 } from "@open-bot/agent";
import {
  bots,
  botThreads,
  chats,
  runs,
  schedules,
  usageEntries,
  type Attachment,
  type schema,
} from "@open-bot/db";
import {
  COMPUTER_PATHS,
  costMicros,
  isNothingToReport,
  shellScript,
  type RunStatus,
  type TimelineItem,
} from "@open-bot/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createNotification, enqueueRun, publishApp, type Context } from "../context";
import { DEVELOPER_INSTRUCTIONS } from "../instructions";
import { errorMessage } from "../logger";
import { TOOLS_VERSION, toolsFor } from "../tools/definitions";
import type { ToolHandlers } from "../tools/handlers";
import { ModelAccess, providerFor } from "../services/model-access";
import { RunEventWriter } from "./events";
import { finalText, mapPlan, mapThreadItem } from "./mapper";

export type Bot = typeof schema.bots.$inferSelect;
export type Chat = typeof schema.chats.$inferSelect;
export type Run = typeof schema.runs.$inferSelect;

type ApprovalPolicy = v2.AskForApproval;

const MAX_COMMAND_OUTPUT = 20_000;

export interface SessionServices {
  tools: ToolHandlers;
  /** Native Codex approvals (commands and file changes) go through the approval service. */
  requestNativeApproval: (
    session: RunSession,
    input: {
      kind: "command" | "file_change";
      title: string;
      detail: string;
      itemId: string;
      subject?: string;
    },
  ) => Promise<boolean>;
  buildPrompt: (session: RunSession) => Promise<string>;
  /** The saved skills a text invokes with `/name`. */
  skillInputs: (text: string, botId: string) => Promise<v2.UserInput[]>;
  /** The MCP servers the bot may use, as Codex config, and a key that changes with them. */
  connections: (
    botId: string,
  ) => Promise<{ key: string; config: NonNullable<v2.ThreadStartParams["config"]> }>;
  model: ModelAccess;
}

interface Outcome {
  status: Extract<RunStatus, "completed" | "failed" | "interrupted">;
  error?: string;
  usageLimit?: boolean;
  unauthorized?: boolean;
}

function approvalPolicy(bot: Bot): ApprovalPolicy {
  return bot.autonomy === "everything" ? "untrusted" : "never";
}

/** Executes one run: a single Codex turn for one bot in one chat. */
export class RunSession {
  readonly writer: RunEventWriter;
  readonly items = new Map<string, TimelineItem>();
  threadId: string | null = null;
  turnId: string | null = null;
  private client: CodexClient | null = null;
  private readonly usage = {
    plan: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    api_key: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  };
  private waits = 0;
  private finish: ((outcome: Outcome) => void) | null = null;
  private cancelled = false;
  private cleanup: (() => void)[] = [];
  private unregisterThread: (() => void) | null = null;
  /** How this run reaches the model. */
  authMode: "plan" | "api_key" = "plan";
  private apiKey: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly services: SessionServices,
    readonly run: Run,
    readonly bot: Bot,
    readonly chat: Chat,
  ) {
    this.writer = new RunEventWriter(ctx.db, ctx.pool, run.id, run.chatId, (error) =>
      ctx.log.error("failed to store a run event", { runId: run.id, error: errorMessage(error) }),
    );
  }

  get identity() {
    return {
      runId: this.run.id,
      botId: this.bot.id,
      botName: this.bot.name,
      ...(this.run.screenId ? { screenId: this.run.screenId } : {}),
    };
  }

  /** A swarm helper, working on one part of a bigger job on a screen of its own. */
  get isHelper(): boolean {
    return this.run.trigger === "swarm";
  }

  get workspace(): string {
    return COMPUTER_PATHS.workspace(this.bot.slug);
  }

  now(): string {
    return new Date().toISOString();
  }

  /** Insert or replace a timeline item. */
  putItem(item: TimelineItem): void {
    this.items.set(item.id, item);
    this.writer.write({ type: "item", item });
  }

  private async setStatus(
    status: RunStatus,
    extra: { error?: string; waitingFor?: "approval" | "takeover" } = {},
  ) {
    this.writer.write({ type: "status", status, ...extra });
    await this.ctx.db
      .update(runs)
      .set({ status, waitingFor: extra.waitingFor ?? null, error: extra.error ?? null })
      .where(eq(runs.id, this.run.id));
  }

  /** Mark the run as waiting on you while `work` runs (an approval or a takeover). */
  async whileWaiting<T>(waitingFor: "approval" | "takeover", work: () => Promise<T>): Promise<T> {
    this.waits += 1;
    if (this.waits === 1) await this.setStatus("waiting", { waitingFor });
    try {
      return await work();
    } finally {
      this.waits -= 1;
      if (this.waits === 0 && this.finish) await this.setStatus("running");
    }
  }

  async execute(): Promise<void> {
    const { ctx, run } = this;
    const log = ctx.log.child("run");
    let outcome: Outcome;
    try {
      await ctx.db.update(runs).set({ startedAt: new Date() }).where(eq(runs.id, run.id));
      await this.setStatus("starting");
      this.client = await ctx.codex.ready();
      const onDisconnect = () =>
        this.finish?.({ status: "failed", error: "Lost the connection to the computer." });
      ctx.codex.on("disconnected", onDisconnect);
      this.cleanup.push(() => ctx.codex.off("disconnected", onDisconnect));

      const prompt = await this.services.buildPrompt(this);
      const input: v2.UserInput[] = [
        { type: "text", text: prompt, text_elements: [] },
        ...(await this.services.skillInputs(run.prompt, this.bot.id)),
      ];
      for (const attachment of run.attachments) {
        if (attachment.mime.startsWith("image/"))
          input.push({ type: "localImage", path: attachment.path });
      }

      let access = await this.services.model.decide();
      outcome = await this.attempt(this.client, input, access);
      // The plan ran out during this run: note until when, and retry once on the API key if allowed.
      if (outcome.usageLimit && this.authMode === "plan" && !this.cancelled) {
        await this.services.model.markPlanLimited();
        access = await this.services.model.decide();
        if (access.decision.mode === "blocked") {
          outcome = await this.attempt(this.client, input, access);
        } else if (access.decision.mode === "api_key") {
          this.putItem({
            id: `fallback-${run.id}`,
            kind: "tool",
            name: "model_fallback",
            label: "Your ChatGPT plan hit its limit, so this continues on your OpenAI API key",
            args: {},
            status: "completed",
            startedAt: this.now(),
            completedAt: this.now(),
          });
          outcome = await this.attempt(this.client, input, access);
        }
      }
    } catch (error) {
      log.error("run failed", { runId: run.id, error: errorMessage(error) });
      outcome = { status: "failed", error: errorMessage(error) };
    } finally {
      for (const fn of this.cleanup) fn();
      this.cleanup = [];
    }
    await this.complete(outcome);
  }

  /** One turn on the plan or on the API key. */
  private async attempt(
    client: CodexClient,
    input: v2.UserInput[],
    access: Awaited<ReturnType<SessionServices["model"]["decide"]>>,
  ): Promise<Outcome> {
    const { ctx, run } = this;
    const { decision } = access;
    if (decision.mode === "blocked") {
      if (decision.reason === "cap_reached") {
        await createNotification(ctx, {
          kind: "cap_reached",
          title: "Your monthly API cap is reached",
          body: "Teammates pause until your ChatGPT plan resets or you raise the cap in Settings.",
        });
      }
      return {
        status: "failed",
        error: ModelAccess.blockedMessage(decision.reason, access.capMicros),
      };
    }
    this.authMode = decision.mode;
    this.apiKey = decision.mode === "api_key" ? access.apiKey : null;
    const threadId = await this.ensureThread(client);
    if (this.threadId !== threadId) {
      this.unregisterThread?.();
      this.threadId = threadId;
      this.unregisterThread = ctx.codex.registerThread(threadId, {
        onNotification: (notification) => this.onNotification(notification),
        onServerRequest: (request) => this.onServerRequest(request),
      });
      this.cleanup.push(() => this.unregisterThread?.());
    }
    const completion = new Promise<Outcome>((resolve) => (this.finish = resolve));
    const { turn } = await client.request("turn/start", {
      threadId,
      input,
      approvalPolicy: approvalPolicy(this.bot),
      model: this.bot.model,
      effort: this.bot.reasoningEffort as v2.TurnStartParams["effort"],
      turnTrigger: run.trigger,
    });
    this.turnId = turn.id;
    await ctx.db
      .update(runs)
      .set({ codexThreadId: threadId, codexTurnId: turn.id, authMode: this.authMode })
      .where(eq(runs.id, run.id));
    await this.setStatus("running");
    if (this.cancelled) void this.interrupt();
    const outcome = await completion;
    if (outcome.status === "failed" && this.authMode === "api_key" && outcome.unauthorized) {
      return { status: "failed", error: "Your OpenAI API key was rejected. Check it in Settings." };
    }
    return outcome;
  }

  /** The thread for this bot and chat, on the access mode this run uses. */
  private async ensureThread(client: CodexClient): Promise<string> {
    const { ctx, run, bot } = this;
    const mode = this.authMode;
    // The services it may use through MCP come with the thread's config.
    const connected = await this.services.connections(bot.id);
    const access = providerFor(mode, this.apiKey, ctx.env);
    // Both add to the thread's config: the API key's provider, and the MCP servers.
    const config = { ...access.config, ...(connected.key ? connected.config : {}) };
    const provider = {
      ...access,
      ...(Object.keys(config).length ? { config } : {}),
    };
    const save = async (threadId: string, fresh: boolean) => {
      await ctx.db
        .insert(botThreads)
        .values({
          chatId: run.chatId,
          botId: bot.id,
          codexThreadId: threadId,
          toolsVersion: TOOLS_VERSION,
          authMode: mode,
          connectionsKey: connected.key,
        })
        .onConflictDoUpdate({
          target: [botThreads.chatId, botThreads.botId],
          // A new thread reads the current profile and lessons in AGENTS.md; a fork keeps what it
          // had seen.
          set: {
            codexThreadId: threadId,
            toolsVersion: TOOLS_VERSION,
            authMode: mode,
            connectionsKey: connected.key,
            ...(fresh ? { profileSeenAt: new Date(), lessonsSeenAt: new Date() } : {}),
          },
        });
      ctx.codex.markLoaded(threadId);
      return threadId;
    };
    const [existing] = await ctx.db
      .select()
      .from(botThreads)
      .where(and(eq(botThreads.chatId, run.chatId), eq(botThreads.botId, bot.id)));
    if (existing && existing.toolsVersion === TOOLS_VERSION) {
      try {
        if (existing.authMode !== mode || existing.connectionsKey !== connected.key) {
          // A thread keeps its provider and its connections, so switching between the plan and
          // the API key, or a change in connections, forks it, carrying the conversation over.
          const fork = await client.request("thread/fork", {
            threadId: existing.codexThreadId,
            cwd: this.workspace,
            ...provider,
          } as v2.ThreadForkParams);
          return await save(fork.thread.id, false);
        }
        if (ctx.codex.isLoaded(existing.codexThreadId)) return existing.codexThreadId;
        await client.request("thread/resume", {
          threadId: existing.codexThreadId,
          cwd: this.workspace,
          ...provider,
        } as v2.ThreadResumeParams);
        ctx.codex.markLoaded(existing.codexThreadId);
        return existing.codexThreadId;
      } catch (error) {
        ctx.log.warn("could not continue a thread, starting a new one", {
          threadId: existing.codexThreadId,
          error: errorMessage(error),
        });
      }
    }
    const response = await client.request("thread/start", {
      model: bot.model,
      cwd: this.workspace,
      approvalPolicy: approvalPolicy(bot),
      sandbox: "danger-full-access",
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: toolsFor(),
      serviceName: "open-bot",
      ...provider,
    } as v2.ThreadStartParams);
    return save(response.thread.id, true);
  }

  /**
   * Add a message to the bot's current turn: one you sent while it works, or your hand-back note.
   * Returns false if the turn already ended.
   */
  async steer(
    messageId: string,
    text: string,
    display: { text: string; variant: "message" | "hand_back" } = { text, variant: "message" },
  ): Promise<boolean> {
    if (!this.client || !this.threadId || !this.turnId || !this.finish) return false;
    try {
      await this.client.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input: [
          { type: "text", text, text_elements: [] },
          ...(await this.services.skillInputs(text, this.bot.id)),
        ],
      });
    } catch (error) {
      this.ctx.log.warn("steer failed", { runId: this.run.id, error: errorMessage(error) });
      return false;
    }
    const now = this.now();
    this.putItem({
      id: `user-${messageId}`,
      kind: "user_message",
      text: display.text,
      variant: display.variant,
      messageId,
      status: "completed",
      startedAt: now,
      completedAt: now,
    });
    return true;
  }

  async interrupt(): Promise<void> {
    this.cancelled = true;
    if (!this.client || !this.threadId || !this.turnId) return;
    await this.client
      .request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
      .catch((error: unknown) =>
        this.ctx.log.warn("interrupt failed", { error: errorMessage(error) }),
      );
  }

  private onNotification(notification: ServerNotification) {
    const now = this.now();
    switch (notification.method) {
      case "item/started": {
        const { item } = notification.params;
        if (item.type === "reasoning") return; // written once it has text
        const mapped = mapThreadItem(item, "started", now);
        if (mapped) this.putItem(mapped);
        return;
      }
      case "item/completed": {
        const { item } = notification.params;
        const mapped = mapThreadItem(item, "completed", now, this.items.get(item.id)?.startedAt);
        if (!mapped) return;
        if (mapped.kind === "command" && mapped.output.length > MAX_COMMAND_OUTPUT) {
          mapped.output = `…\n${mapped.output.slice(-MAX_COMMAND_OUTPUT)}`;
        }
        this.putItem(mapped);
        return;
      }
      case "item/agentMessage/delta":
        this.appendText(notification.params.itemId, notification.params.delta);
        return;
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta } = notification.params;
        if (!this.items.has(itemId)) {
          this.putItem({
            id: itemId,
            kind: "reasoning",
            text: "",
            status: "running",
            startedAt: now,
          });
        }
        this.appendText(itemId, delta);
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const item = this.items.get(notification.params.itemId);
        if (item?.kind === "reasoning" && item.text) this.appendText(item.id, "\n\n");
        return;
      }
      case "item/commandExecution/outputDelta": {
        const item = this.items.get(notification.params.itemId);
        if (item?.kind === "command" && item.output.length < MAX_COMMAND_OUTPUT) {
          item.output += notification.params.delta;
          this.writer.delta(item.id, notification.params.delta);
        }
        return;
      }
      case "turn/plan/updated":
        if (notification.params.plan.length > 0) {
          this.putItem(
            mapPlan(notification.params.plan, `plan-${notification.params.turnId}`, now),
          );
        }
        return;
      case "thread/tokenUsage/updated": {
        const last = notification.params.tokenUsage.last;
        const usage = this.usage[this.authMode];
        usage.inputTokens += last.inputTokens;
        usage.cachedInputTokens += last.cachedInputTokens;
        usage.outputTokens += last.outputTokens;
        return;
      }
      case "turn/completed": {
        const { turn } = notification.params;
        if (turn.id !== this.turnId) return;
        const info = turn.error?.codexErrorInfo;
        if (turn.status === "completed") this.finish?.({ status: "completed" });
        else if (turn.status === "interrupted") this.finish?.({ status: "interrupted" });
        else {
          const status =
            typeof info === "object" && info !== null && "httpConnectionFailed" in info
              ? (info as { httpConnectionFailed: { httpStatusCode: number | null } })
                  .httpConnectionFailed.httpStatusCode
              : null;
          this.finish?.({
            status: "failed",
            error: turn.error?.message ?? "The turn failed.",
            usageLimit: info === "usageLimitExceeded",
            unauthorized: info === "unauthorized" || status === 401,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private appendText(itemId: string, delta: string) {
    const item = this.items.get(itemId);
    if (item && (item.kind === "message" || item.kind === "reasoning")) {
      item.text += delta;
      this.writer.delta(itemId, delta);
    }
  }

  private async onServerRequest(request: ServerRequest): Promise<unknown> {
    switch (request.method) {
      case "item/tool/call":
        return this.services.tools.handle(this, request.params);
      case "item/commandExecution/requestApproval": {
        const params = request.params;
        const command = params.command ?? "a command";
        const script = shellScript(command);
        const approved = await this.services.requestNativeApproval(this, {
          kind: "command",
          subject: command,
          title: `Run \`${script.length > 80 ? `${script.slice(0, 80)}…` : script}\``,
          detail: [params.reason, `$ ${script}`, params.cwd ? `in ${params.cwd}` : null]
            .filter(Boolean)
            .join("\n"),
          itemId: `approval-${params.itemId}-${params.approvalId ?? ""}`,
        });
        return { decision: approved ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const params = request.params;
        const item = this.items.get(params.itemId);
        const paths = item?.kind === "file_change" ? item.changes.map((change) => change.path) : [];
        const approved = await this.services.requestNativeApproval(this, {
          kind: "file_change",
          title: paths.length
            ? `Change ${paths.length === 1 ? paths[0] : `${paths.length} files`}`
            : "Change files",
          detail: [
            params.reason,
            ...(item?.kind === "file_change" ? item.changes.map((c) => c.diff) : []),
          ]
            .filter(Boolean)
            .join("\n\n"),
          itemId: `approval-${params.itemId}`,
        });
        return { decision: approved ? "accept" : "decline" };
      }
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        throw new Error(`open-bot doesn't handle ${request.method}`);
    }
  }

  /** Sends the answer to a teammate's question back to them, in the chat they asked from. */
  /** A quiet routine's run that found nothing worth telling you. */
  private async quietWithNothingToReport(text: string | null): Promise<boolean> {
    const { run, ctx } = this;
    if (run.trigger !== "schedule" || !run.scheduleId || !isNothingToReport(text)) return false;
    const [schedule] = await ctx.db
      .select({ quiet: schedules.quiet })
      .from(schedules)
      .where(eq(schedules.id, run.scheduleId));
    return schedule?.quiet ?? false;
  }

  private async answerBack(status: Outcome["status"], text: string | null, error?: string) {
    const { ctx, run, bot } = this;
    if (!run.parentRunId) return;
    const [asker] = await ctx.db
      .select({ chatId: runs.chatId, botId: runs.botId })
      .from(runs)
      .innerJoin(bots, eq(bots.id, runs.botId))
      .where(and(eq(runs.id, run.parentRunId), isNull(bots.archivedAt)));
    if (!asker) return;
    const answer =
      status === "completed"
        ? `[${bot.name} answered your question:]\n${text ?? "(No reply.)"}`
        : status === "failed"
          ? `[${bot.name} couldn't answer your question: ${error ?? "the run failed"}. Carry on without it, or ask the user.]`
          : `[The user stopped ${bot.name} before they answered. Carry on without it, or ask the user.]`;
    await enqueueRun(ctx, {
      chatId: asker.chatId,
      botId: asker.botId,
      trigger: "answer",
      prompt: answer,
      parentRunId: run.id,
    });
  }

  private async complete(outcome: Outcome) {
    const { ctx, run, bot, chat } = this;
    this.finish = null;
    const items = [...this.items.values()];
    const text = finalText(items);
    let { status } = outcome;
    let error = outcome.error;
    if (this.cancelled && status !== "completed") {
      status = "interrupted";
      error = undefined;
    }
    if (outcome.usageLimit && status === "failed") {
      error = ModelAccess.blockedMessage("no_key", 0);
    }
    if (status === "failed" && error) {
      this.putItem({
        id: `error-${run.id}`,
        kind: "error",
        message: error,
        status: "failed",
        startedAt: this.now(),
      });
    }
    // Close anything still marked as running, so the timeline never shows a stuck spinner.
    for (const item of items) {
      if (item.status === "running") {
        this.putItem({
          ...item,
          status: status === "completed" ? "completed" : "failed",
          completedAt: this.now(),
        } as TimelineItem);
      }
    }
    // Free the desktop and store the final state first, so the event below reaches clients
    // that then read a consistent run row and lease.
    await ctx.computer.releaseRun(run.id).catch(() => {});
    await ctx.db
      .update(runs)
      .set({
        status,
        error: error ?? null,
        waitingFor: null,
        finalText: text,
        completedAt: new Date(),
      })
      .where(eq(runs.id, run.id));
    await ctx.db.update(chats).set({ lastActivityAt: new Date() }).where(eq(chats.id, chat.id));
    const total = {
      inputTokens: this.usage.plan.inputTokens + this.usage.api_key.inputTokens,
      cachedInputTokens: this.usage.plan.cachedInputTokens + this.usage.api_key.cachedInputTokens,
      outputTokens: this.usage.plan.outputTokens + this.usage.api_key.outputTokens,
    };
    this.writer.write({ type: "usage", ...total });
    this.writer.write({ type: "status", status, ...(error ? { error } : {}) });
    await this.writer.drain();
    for (const mode of ["plan", "api_key"] as const) {
      const usage = this.usage[mode];
      if (usage.inputTokens + usage.outputTokens === 0) continue;
      await ctx.db
        .insert(usageEntries)
        .values({
          runId: run.id,
          botId: bot.id,
          authMode: mode,
          ...usage,
          // The plan is a flat subscription; only the API key costs money per token.
          costMicros: mode === "api_key" ? costMicros(usage) : 0,
          idempotencyKey: `run:${run.id}:${mode}`,
        })
        .onConflictDoNothing();
    }

    if (run.trigger === "question") await this.answerBack(status, text, error);
    ctx.events.emit("runFinished", run, status, text, error);

    if (status === "failed" && run.trigger !== "swarm") {
      await createNotification(ctx, {
        kind: "run_failed",
        title: `${bot.name} couldn't finish`,
        body: error ?? "The run failed.",
        botId: bot.id,
        chatId: chat.id,
        runId: run.id,
      });
    } else if (
      status === "completed" &&
      run.trigger !== "question" &&
      // A helper's part comes back to its teammate, not to you.
      run.trigger !== "swarm" &&
      !(await this.quietWithNothingToReport(text))
    ) {
      // An answer to a teammate isn't news for you; their reply to you is.
      await createNotification(ctx, {
        kind: "run_finished",
        title:
          run.trigger === "schedule"
            ? `${bot.name} finished a scheduled task`
            : run.trigger === "watch"
              ? `${bot.name} looked into a page change`
              : run.trigger === "webhook"
                ? `${bot.name} handled a webhook`
                : `${bot.name} replied`,
        body: (text ?? "Done.").slice(0, 280),
        botId: bot.id,
        chatId: chat.id,
        runId: run.id,
      });
    }
    await publishApp(ctx, { type: "chats" });
  }
}

export type { Attachment };
