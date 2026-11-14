// RunSession: one run's state, its turn with the plan-to-API-key fallback, steering and interrupt.
// Choosing the thread, mapping notifications, answering server requests and finishing the run live
// beside it (./threads, ./notifications, ./approvals, ./finalize) as functions of the session.
import type { CodexClient, v2 } from "@open-bot/agent";
import { runs } from "@open-bot/db";
import {
  COMPUTER_PATHS,
  type NativeApprovalKind,
  type RunStatus,
  type RunWait,
  type TimelineItem,
} from "@open-bot/domain";
import { eq } from "drizzle-orm";
import type { Context } from "../../context";
import type { Teammate, Chat, Run } from "../../core/db-types";
import { createNotification } from "../../features/notifications";
import { errorMessage } from "../../logger";
import type { MemoryService } from "@open-bot/memory";
import { ModelAccess } from "../../features/model-access";
import { approvalPolicy } from "../approval-policy";
import { RunEventWriter } from "../events";
import { onServerRequest } from "./approvals";
import { complete, type Outcome } from "./finalize";
import { onNotification } from "./notifications";
import { ensureThread } from "./threads";

/** The agent tools, as a session uses them (ToolHandlers in ../../tools/handlers.ts). */
export interface SessionTools {
  /** The tools a new thread is given. */
  specs(): v2.DynamicToolSpec[];
  handle(
    session: RunSession,
    params: v2.DynamicToolCallParams,
  ): Promise<v2.DynamicToolCallResponse>;
}

export interface SessionServices {
  tools: SessionTools;
  /** Native Codex approvals (commands and file changes) go through the approval service. */
  requestNativeApproval: (
    session: RunSession,
    input: {
      kind: NativeApprovalKind;
      title: string;
      detail: string;
      itemId: string;
      subject?: string;
    },
  ) => Promise<boolean>;
  buildPrompt: (session: RunSession) => Promise<string>;
  /** Marks the chat as active now, when the run has finished. */
  touchChat: (chatId: string) => Promise<void>;
  /** The saved skills a text invokes with `/name`. */
  skillInputs: (text: string, teammateId: string) => Promise<v2.UserInput[]>;
  /** The MCP servers the teammate may use, as Codex config, and a key that changes with them. */
  connections: (
    teammateId: string,
  ) => Promise<{ key: string; config: NonNullable<v2.ThreadStartParams["config"]> }>;
  model: ModelAccess;
  /**
   * The memory store and its AI, from the memory feature's coordinator: typed from the memory
   * package, since importing the feature would close a cycle through its tools.
   */
  memory: { store: MemoryService; ai: { config: { extractionUrl?: string | undefined } } };
  /** Writes the teammate's workspace; returns the AGENTS.md it wrote. */
  prepareWorkspace: () => Promise<string>;
}

/**
 * Executes one run: a single Codex turn for one teammate in one chat.
 * State the session's own modules read is not private; feature code uses only what it documents.
 */
export class RunSession {
  readonly writer: RunEventWriter;
  readonly items = new Map<string, TimelineItem>();

  /** The last page this run published, if any. */
  publishedPageId(): string | null {
    let pageId: string | null = null;
    for (const item of this.items.values()) if (item.kind === "page") pageId = item.pageId;
    return pageId;
  }
  memoryGeneration = "";
  threadId: string | null = null;
  turnId: string | null = null;
  private client: CodexClient | null = null;
  readonly usage = {
    plan: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    api_key: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  };
  private waits = 0;
  finish: ((outcome: Outcome) => void) | null = null;
  cancelled = false;
  private cleanup: (() => void)[] = [];
  private unregisterThread: (() => void) | null = null;
  /** How this run reaches the model. */
  authMode: "plan" | "api_key" = "plan";
  apiKey: string | null = null;
  /** The AGENTS.md written for this run. */
  agentsFile = "";

  constructor(
    readonly ctx: Context,
    readonly services: SessionServices,
    readonly run: Run,
    readonly teammate: Teammate,
    readonly chat: Chat,
  ) {
    this.writer = new RunEventWriter(ctx.db, ctx.pool, run.id, run.chatId, (error) =>
      ctx.log.error("failed to store a run event", { runId: run.id, error: errorMessage(error) }),
    );
  }

  get identity() {
    return {
      runId: this.run.id,
      botId: this.teammate.id,
      botName: this.teammate.name,
      ...(this.run.screenId ? { screenId: this.run.screenId } : {}),
    };
  }

  /** A swarm helper, working on one part of a bigger job on a screen of its own. */
  get isHelper(): boolean {
    return this.run.trigger === "swarm";
  }

  get workspace(): string {
    return COMPUTER_PATHS.workspace(this.teammate.slug);
  }

  now(): string {
    return new Date().toISOString();
  }

  /**
   * The run read mail, events or pages from your accounts. From now on, everything it sends out
   * asks you first, and the runs it starts carry the same mark.
   */
  async markReadOutsideData(): Promise<void> {
    if (this.run.readOutsideData) return;
    this.run.readOutsideData = true;
    await this.ctx.db.update(runs).set({ readOutsideData: true }).where(eq(runs.id, this.run.id));
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
  async whileWaiting<T>(waitingFor: RunWait, work: () => Promise<T>): Promise<T> {
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
    let releaseDemand: (() => void) | undefined;
    try {
      try {
        await ctx.db.update(runs).set({ startedAt: new Date() }).where(eq(runs.id, run.id));
        await this.setStatus("starting");
        releaseDemand = await ctx.lifecycle?.hold(`run:${run.id}`);
        if (this.cancelled) throw new Error("Run cancelled while waking the computer");
        this.agentsFile = await this.services.prepareWorkspace();
        this.client = await ctx.codex.ready();
        const onDisconnect = () =>
          this.finish?.({ status: "failed", error: "Lost the connection to the computer." });
        ctx.codex.on("disconnected", onDisconnect);
        this.cleanup.push(() => ctx.codex.off("disconnected", onDisconnect));

        const prompt = await this.services.buildPrompt(this);
        const input: v2.UserInput[] = [
          { type: "text", text: prompt, text_elements: [] },
          ...(await this.services.skillInputs(run.prompt, this.teammate.id)),
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
      await complete(this, outcome);
      if (outcome.status === "completed" && this.services.memory.ai.config.extractionUrl) {
        await this.services.memory.store
          .queueExtraction(run.id)
          .catch(() => ctx.log.warn("Could not queue memory extraction."));
      }
    } finally {
      releaseDemand?.();
    }
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
    const threadId = await ensureThread(this, client);
    if (this.threadId !== threadId) {
      this.unregisterThread?.();
      this.threadId = threadId;
      this.unregisterThread = ctx.codex.registerThread(threadId, {
        onNotification: (notification) => onNotification(this, notification),
        onServerRequest: (request) => onServerRequest(this, request),
      });
      this.cleanup.push(() => this.unregisterThread?.());
    }
    const completion = new Promise<Outcome>((resolve) => (this.finish = resolve));
    const currentGeneration = await this.services.memory.store.generation(this.teammate.id);
    const [latestRun] = await ctx.db
      .select({ cancelRequestedAt: runs.cancelRequestedAt })
      .from(runs)
      .where(eq(runs.id, run.id));
    if (
      currentGeneration !== this.memoryGeneration ||
      !latestRun ||
      latestRun.cancelRequestedAt ||
      this.cancelled
    ) {
      return {
        status: "interrupted",
        error: "Memory changed while this task was starting. Retry with current memory.",
      };
    }
    const { turn } = await client.request("turn/start", {
      threadId,
      input,
      approvalPolicy: approvalPolicy(this.teammate),
      model: this.teammate.model,
      effort: this.teammate.reasoningEffort as v2.TurnStartParams["effort"],
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

  /**
   * Add a message to the teammate's current turn: one you sent while it works, or your hand-back note.
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
          ...(await this.services.skillInputs(text, this.teammate.id)),
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
}
