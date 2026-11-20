import type { AuthMode } from "@open-bot/domain";
import type { RunSession } from "./session";

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

  /** The executing run of a teammate in a chat, if any. */
  find(chatId: string, teammateId: string, lane = "chat"): RunSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.chat.id === chatId &&
        session.teammate.id === teammateId &&
        (session.run.lane ?? "chat") === lane
      )
        return session;
    }
    return undefined;
  }

  /**
   * The live run on the API key that one of these Codex threads belongs to: the model proxy adds
   * the key only for it, so the key is never spent outside a run that passed the cap check.
   */
  apiKeyRun(threadIds: readonly string[]): { apiKey: string; teammateId: string } | null {
    for (const session of this.sessions.values()) {
      if (session.authMode !== "api_key" || !session.apiKey || !session.threadId) continue;
      if (threadIds.includes(session.threadId))
        return { apiKey: session.apiKey, teammateId: session.teammate.id };
    }
    return null;
  }

  /** The teammate whose live run one of these Codex threads belongs to, on either access mode. */
  teammateFor(threadIds: readonly string[]): string | null {
    for (const session of this.sessions.values())
      if (session.threadId && threadIds.includes(session.threadId)) return session.teammate.id;
    return null;
  }

  /** The live run whose current thread this is. */
  runForThread(threadId: string): { runId: string; accessMode: AuthMode } | null {
    for (const session of this.sessions.values())
      if (session.threadId === threadId)
        return { runId: session.run.id, accessMode: session.authMode };
    return null;
  }

  /** How a live run reaches the model right now, or null when it isn't live. */
  accessMode(runId: string): AuthMode | null {
    return this.sessions.get(runId)?.authMode ?? null;
  }

  all(): RunSession[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }
}
