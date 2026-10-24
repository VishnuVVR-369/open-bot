import { chats, runs, swarms, swarmTasks, type SwarmTaskStatus } from "@open-bot/db";
import { MAX_SWARM_TASKS, type SwarmItem } from "@open-bot/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendRunEvent, enqueueRun, publishApp, signalWorker, type Context } from "../context";
import { errorMessage } from "../logger";
import type { RunSession } from "../runs/session";
import type { SessionRegistry } from "./registry";

type Swarm = typeof swarms.$inferSelect;
type Task = typeof swarmTasks.$inferSelect;

/** How much of each helper's result comes back to the teammate. */
const MAX_RESULT_CHARS = 12_000;

export class SwarmError extends Error {}

const DONE: SwarmTaskStatus[] = ["completed", "failed", "stopped"];

function helperPrompt(
  swarm: { title: string },
  task: { title: string; instructions: string },
  index: number,
  count: number,
  lead: string,
): string {
  return `[Swarm helper ${index + 1} of ${count}: "${swarm.title}"]

You're one of ${count} helpers ${lead} started to work on parts of a bigger job at the same time, each on a screen of its own. Do only your part:

## ${task.title}

${task.instructions}

Rules for helpers:
- Don't message or notify the user, start a swarm, ask teammates, schedule anything, or change the task board.
- If you need the user (a sign-in, a code, a CAPTCHA), stop and say exactly what you needed in your result.
- Close the browser tabs you opened when you're done.
- Reply with just your result, complete and self-contained: it's merged with the other helpers' results.`;
}

/**
 * Swarms: a teammate splits a big job into parts that helpers work on at the same time, each on
 * its own screen, and gets the results back as one message when they're all done.
 */
export class SwarmService {
  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionRegistry,
  ) {
    ctx.events.on("runStarted", (run) => {
      if (run.trigger !== "swarm") return;
      void this.taskStarted(run.id).catch(() => {});
    });
    ctx.events.on("runFinished", (run, status, text, error) => {
      if (run.trigger !== "swarm") return;
      void this.taskFinished(run.id, status, text, error).catch((cause: unknown) =>
        ctx.log.error("could not record a swarm helper's result", { error: errorMessage(cause) }),
      );
    });
  }

  async start(
    session: RunSession,
    input: { title: string; tasks: { title: string; instructions: string }[]; itemId: string },
  ): Promise<{ swarm: Swarm; tasks: Task[] }> {
    if (session.isHelper) throw new SwarmError("Helpers can't start swarms of their own.");
    const title = input.title.trim().slice(0, 120);
    const parts = input.tasks
      .map((task) => ({
        title: task.title.trim().slice(0, 120),
        instructions: task.instructions.trim().slice(0, 8000),
      }))
      .filter((task) => task.title && task.instructions);
    if (!title) throw new SwarmError("Give the swarm a title.");
    if (parts.length < 2) throw new SwarmError("A swarm needs at least 2 parts.");
    if (parts.length > MAX_SWARM_TASKS)
      throw new SwarmError(`A swarm can have up to ${MAX_SWARM_TASKS} parts. Combine some.`);
    const [running] = await this.ctx.db
      .select({ id: swarms.id })
      .from(swarms)
      .where(and(eq(swarms.botId, session.bot.id), eq(swarms.status, "running")))
      .limit(1);
    if (running)
      throw new SwarmError(
        "You already have a swarm working. Wait for its results before starting another.",
      );

    const { swarm, tasks } = await this.ctx.db.transaction(async (tx) => {
      const [swarm] = await tx
        .insert(swarms)
        .values({
          botId: session.bot.id,
          chatId: session.chat.id,
          runId: session.run.id,
          itemId: input.itemId,
          title,
        })
        .returning();
      const tasks: Task[] = [];
      for (const [position, part] of parts.entries()) {
        const [chat] = await tx
          .insert(chats)
          .values({ kind: "helper", title: part.title, botId: session.bot.id })
          .returning({ id: chats.id });
        const [task] = await tx
          .insert(swarmTasks)
          .values({ swarmId: swarm!.id, position, ...part, chatId: chat!.id })
          .returning();
        tasks.push(task!);
      }
      return { swarm: swarm!, tasks };
    });
    for (const [index, task] of tasks.entries()) {
      const runId = await enqueueRun(this.ctx, {
        chatId: task.chatId!,
        botId: session.bot.id,
        trigger: "swarm",
        prompt: helperPrompt(swarm, task, index, tasks.length, session.bot.name),
        parentRunId: session.run.id,
        // Each helper works on a screen of its own, named after its part.
        screenId: task.id,
      });
      await this.ctx.db.update(swarmTasks).set({ runId }).where(eq(swarmTasks.id, task.id));
      task.runId = runId;
    }
    await this.showProgress(swarm.id);
    return { swarm, tasks };
  }

  /** A helper's run started or ended. */
  async taskStarted(runId: string): Promise<void> {
    const [task] = await this.ctx.db
      .update(swarmTasks)
      .set({ status: "running" })
      .where(and(eq(swarmTasks.runId, runId), eq(swarmTasks.status, "queued")))
      .returning();
    if (task) await this.showProgress(task.swarmId);
  }

  private async taskFinished(
    runId: string,
    status: "completed" | "failed" | "interrupted",
    text: string | null,
    error?: string,
  ): Promise<void> {
    const [task] = await this.ctx.db
      .update(swarmTasks)
      .set({
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
        result:
          status === "completed"
            ? (text ?? "").slice(0, MAX_RESULT_CHARS)
            : (error ?? (status === "interrupted" ? "It was stopped." : "It failed.")),
        completedAt: new Date(),
      })
      .where(and(eq(swarmTasks.runId, runId), inArray(swarmTasks.status, ["queued", "running"])))
      .returning();
    if (!task) return;
    await this.forgetScreen(task.id);
    await this.finishIfDone(task.swarmId);
  }

  private async finishIfDone(swarmId: string): Promise<void> {
    const tasks = await this.tasksOf(swarmId);
    if (!tasks.every((task) => DONE.includes(task.status))) {
      await this.showProgress(swarmId);
      return;
    }
    const [swarm] = await this.ctx.db
      .update(swarms)
      .set({ status: "done", completedAt: new Date() })
      .where(and(eq(swarms.id, swarmId), eq(swarms.status, "running")))
      .returning();
    await this.showProgress(swarmId);
    if (!swarm) return;
    const parts = tasks
      .map(
        (task, index) =>
          `## ${index + 1}. ${task.title}${task.status === "completed" ? "" : ` (${task.status === "failed" ? "failed" : "stopped"})`}\n\n${task.result?.trim() || "No result."}`,
      )
      .join("\n\n");
    await enqueueRun(this.ctx, {
      chatId: swarm.chatId,
      botId: swarm.botId,
      trigger: "swarm_results",
      prompt: `[Swarm results: "${swarm.title}"]\n\nYour ${tasks.length} helpers finished. Merge their results into one answer for the user: compare, dedupe and check them, say what's missing, and finish the job you split up.\n\n${parts}`,
      parentRunId: swarm.runId,
    });
  }

  /** You stopped a swarm: its helpers stop, and nothing comes back. */
  async stop(swarmId: string): Promise<void> {
    const [swarm] = await this.ctx.db
      .update(swarms)
      .set({ status: "stopped", completedAt: new Date() })
      .where(and(eq(swarms.id, swarmId), eq(swarms.status, "running")))
      .returning();
    if (!swarm) return;
    const open = await this.ctx.db
      .update(swarmTasks)
      .set({ status: "stopped", result: "You stopped it.", completedAt: new Date() })
      .where(
        and(eq(swarmTasks.swarmId, swarmId), inArray(swarmTasks.status, ["queued", "running"])),
      )
      .returning();
    const runIds = open.flatMap((task) => (task.runId ? [task.runId] : []));
    if (runIds.length) {
      await this.ctx.db
        .update(runs)
        .set({ cancelRequestedAt: new Date() })
        .where(inArray(runs.id, runIds));
      await signalWorker(this.ctx, "cancel");
    }
    for (const task of open) await this.forgetScreen(task.id);
    await this.showProgress(swarmId);
  }

  private tasksOf(swarmId: string): Promise<Task[]> {
    return this.ctx.db
      .select()
      .from(swarmTasks)
      .where(eq(swarmTasks.swarmId, swarmId))
      .orderBy(asc(swarmTasks.position));
  }

  /** The helper's screen goes when its part is done; sign-ins stay in the shared jar. */
  private async forgetScreen(screenId: string): Promise<void> {
    await this.ctx.computer
      .forgetScreen(screenId)
      .catch((error: unknown) =>
        this.ctx.log.warn("could not remove a helper's screen", { error: errorMessage(error) }),
      );
  }

  /** Update the swarm's card in the run that started it. */
  private async showProgress(swarmId: string): Promise<void> {
    const [swarm] = await this.ctx.db.select().from(swarms).where(eq(swarms.id, swarmId));
    if (!swarm) return;
    const tasks = await this.tasksOf(swarmId);
    const item: SwarmItem = {
      id: swarm.itemId,
      kind: "swarm",
      swarmId: swarm.id,
      title: swarm.title,
      state: swarm.status,
      status: swarm.status === "running" ? "running" : "completed",
      startedAt: swarm.createdAt.toISOString(),
      ...(swarm.completedAt ? { completedAt: swarm.completedAt.toISOString() } : {}),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        state: task.status,
        chatId: task.chatId,
        ...(task.result ? { result: task.result.slice(0, 280) } : {}),
      })),
    };
    const session = this.sessions.get(swarm.runId);
    if (session) session.putItem(item);
    else await appendRunEvent(this.ctx, swarm.runId, swarm.chatId, { type: "item", item });
    await publishApp(this.ctx, { type: "chats" });
  }
}
