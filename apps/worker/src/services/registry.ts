import type { RunLane } from "@open-bot/db";
import type { RunSession } from "../runs/session";

/** The runs executing right now, by run id. */
export class SessionRegistry {
  private readonly sessions = new Map<string, RunSession>();

  add(session: RunSession): void {
    this.sessions.set(session.run.id, session);
  }

  remove(runId: string): void {
    this.sessions.delete(runId);
  }

  get(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  /** The executing run of a teammate in one lane of a chat, if any. */
  find(chatId: string, teammateId: string, lane: RunLane): RunSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.chat.id === chatId && session.bot.id === teammateId && session.run.lane === lane)
        return session;
    }
    return undefined;
  }

  all(): RunSession[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }
}
