// RunExecutor: claims queued runs and starts their sessions, one at a time per teammate per chat,
// recovers runs a restart interrupted, and stops cancelled ones. Message dispatch, prompts and
// workspace sync live beside it (./dispatch, ./prompt, ./workspace-sync) as functions of it.
import { teammates, chats, runs } from "@open-bot/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Context } from "../../context";
import type { Bot } from "../../core/db-types";
import type { ApprovalService } from "../../features/approvals";
import { touchChat } from "../../features/chat";
import type { ConnectionService } from "../../features/connections";
import type { AccountAccess } from "../../features/integrations";
import type { MemoryCoordinator } from "../../features/memory";
import type { ModelAccess } from "../../features/model-access";
import type { TakeoverService } from "../../features/screens";
import type { SkillService } from "../../features/skills";
import { errorMessage } from "../../logger";
import { appendRunEvent } from "../events";
import type { SessionRegistry } from "../registry";
import { RunSession, type SessionTools } from "../session";
import { DISPATCH_GRACE_MS, dispatchMessage, reconcileDispatches, recoverSteers } from "./dispatch";
import { buildPrompt } from "./prompt";
import { syncWorkspace } from "./workspace-sync";

/**
 * Claims queued runs and executes them, one at a time per bot per chat.
 * State its own modules read is not private; callers use only its methods.
 */
export class RunExecutor {
  private pumping = false;
  private again = false;

  constructor(
    readonly ctx: Context,
    readonly sessions: SessionRegistry,
    private readonly tools: SessionTools,
    readonly approvals: ApprovalService,
    private readonly takeovers: TakeoverService,
    private readonly model: ModelAccess,
    readonly skills: SkillService,
    readonly connections: ConnectionService,
    readonly memory: MemoryCoordinator,
    readonly accounts: AccountAccess,
  ) {}

  /** Runs that were executing when the worker stopped can't resume their turn. */
  async recover(): Promise<void> {
    const stale = await this.ctx.db
      .update(runs)
      .set({
        status: "interrupted",
        waitingFor: null,
        error: "Interrupted when the computer restarted.",
        completedAt: new Date(),
      })
      .where(inArray(runs.status, ["starting", "running", "waiting"]))
      .returning({ id: runs.id, chatId: runs.chatId, trigger: runs.trigger });
    for (const run of stale) {
      await appendRunEvent(this.ctx, run.id, run.chatId, {
        type: "status",
        status: "interrupted",
        error: "Interrupted when the computer restarted.",
      });
      await this.approvals.expireForRun(run.id);
      this.ctx.events.emit(
        "runFinished",
        run,
        "interrupted",
        null,
        "Interrupted when the computer restarted.",
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
    const [bot] = await this.ctx.db
      .select()
      .from(teammates)
      .where(eq(teammates.id, run.teammateId));
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
        buildPrompt: (s) => buildPrompt(this, s),
        touchChat: (chatId) => touchChat(this.ctx.db, chatId),
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
        await this.approvals.expireForRun(run.id).catch((error: unknown) =>
          this.ctx.log.warn("couldn't expire the run's approvals", {
            runId: run.id,
            error: errorMessage(error),
          }),
        );
        this.pump();
      }
    })();
  }

  /** Write the teammate's AGENTS.md, MEMORY.md and skills. */
  syncWorkspace(
    bot: Pick<Bot, "id" | "slug" | "name" | "role" | "instructions" | "autonomy">,
  ): Promise<string> {
    return syncWorkspace(this, bot);
  }

  /**
   * Route a message you sent: join a bot's running turn, or start a run. Safe to call more than
   * once for the same message: each teammate is claimed in `message_dispatches` before it gets the
   * message, so it gets it once.
   */
  dispatchMessage(messageId: string): Promise<void> {
    return dispatchMessage(this, messageId);
  }

  /**
   * Steers that were being delivered when the worker stopped. The turn they joined ended with
   * that worker, so the message can't have been answered: it becomes a run of its own.
   * Call on startup, before anything can steer.
   */
  recoverSteers(): Promise<void> {
    return recoverSteers(this);
  }

  /** Dispatch messages that were saved but never dispatched, like after a crash in between. */
  reconcileDispatches(olderThanMs = DISPATCH_GRACE_MS): Promise<void> {
    return reconcileDispatches(this, olderThanMs);
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
