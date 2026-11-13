import type { ApiInputs } from "@open-bot/api";
import { bots as teammates, chats, messages, runs } from "@open-bot/db"; // vocabulary: allow
import type { MemoryService } from "@open-bot/memory";
import { eq } from "drizzle-orm";
import type { Context } from "../context";
import { REUSED_ID, saveUserMessage, type ChatService } from "../features/chat";
import { requestRunsCancel } from "./cancel";
import { WorkerError } from "../core/errors";

/** A request about a run that can't be done as asked; the message says why. */
export class RunError extends WorkerError {}

const GONE = "That reply is gone.";

type Feedback = ApiInputs["runs"]["feedback"];

/** What the owner asks of a run: stop it, rate it, or say what to do differently. */
export class RunRequests {
  constructor(
    private readonly ctx: Context,
    private readonly chats: Pick<ChatService, "deliver">,
    private readonly memory: Pick<MemoryService, "save">,
    /** Stop the runs marked as cancelled now (the executor). */
    private readonly processCancellations: () => Promise<void>,
  ) {}

  async stop(runId: string) {
    if (!(await requestRunsCancel(this.ctx.db, [runId])).length) throw new RunError(404, GONE);
    await this.processCancellations();
  }

  async rate(runId: string, rating: "up" | "down" | null) {
    const [run] = await this.ctx.db
      .update(runs)
      .set({ rating })
      .where(eq(runs.id, runId))
      .returning({ id: runs.id });
    if (!run) throw new RunError(404, GONE);
  }

  /**
   * A thumbs down with what to change. Saved as a lesson, the teammate reads it before every task;
   * with `redo`, it's also sent to the chat so the teammate tries again now. The redo message's id
   * makes a retry safe: once it's saved, the same feedback isn't saved or sent again.
   */
  async feedback(input: Feedback) {
    const request = { text: input.text, remember: input.remember };
    const matches = (sent: Pick<typeof messages.$inferSelect, "redoOfRunId" | "feedbackRequest">) =>
      sent.redoOfRunId === input.runId &&
      sent.feedbackRequest?.text === request.text &&
      sent.feedbackRequest.remember === request.remember;
    if (input.redo) {
      const [sent] = await this.ctx.db
        .select()
        .from(messages)
        .where(eq(messages.clientId, input.redo.clientId));
      if (sent) {
        if (!matches(sent)) throw new RunError(409, REUSED_ID);
        await this.chats.deliver(sent.id);
        return;
      }
    }
    const [run] = await this.ctx.db
      .select({
        id: runs.id,
        teammateId: runs.botId, // vocabulary: allow
        chatId: runs.chatId,
        name: teammates.name,
      })
      .from(runs)
      .innerJoin(teammates, eq(teammates.id, runs.botId)) // vocabulary: allow
      .where(eq(runs.id, input.runId));
    if (!run) throw new RunError(404, GONE);
    // A redo's lesson is saved by its durable dispatcher before the teammate receives it.
    // A crash after accepting the message must not lose the instruction to remember it.
    if (!input.redo) {
      await this.rate(run.id, "down");
      if (input.remember)
        await this.memory.save(
          {
            botId: run.teammateId,
            kind: "lesson",
            content: input.text,
            key: null,
            pinned: true,
            expiresAt: null,
          },
          { kind: "user" },
          { source: { type: "feedback", runId: run.id } },
        );
      return;
    }
    const [chat] = await this.ctx.db
      .select({ kind: chats.kind })
      .from(chats)
      .where(eq(chats.id, run.chatId));
    const group = chat?.kind === "group";
    const { message } = await saveUserMessage(this.ctx.db, {
      clientId: input.redo.clientId,
      chatId: run.chatId,
      // In a group, the message goes to the teammate who replied.
      text: group ? `@${run.name} ${input.text}` : input.text,
      mentions: group ? [run.teammateId] : [],
      redoOfRunId: run.id,
      feedbackRequest: request,
    });
    if (!matches(message)) throw new RunError(409, REUSED_ID);
    await this.rate(run.id, "down");
    await this.chats.deliver(message.id);
  }
}
