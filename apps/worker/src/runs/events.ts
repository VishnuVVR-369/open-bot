import { CHANNELS, notify, runEvents, type Db } from "@open-bot/db";
import type { RunEventPayload } from "@open-bot/shared";
import type pg from "pg";

const DELTA_FLUSH_MS = 120;

/**
 * Appends a run's events in order. Streamed text deltas are coalesced, so a long answer
 * becomes a handful of events instead of thousands.
 */
export class RunEventWriter {
  private queue: Promise<void> = Promise.resolve();
  private readonly deltas = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly pool: pg.Pool,
    private readonly runId: string,
    private readonly chatId: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Append an event. Pending deltas for an item that is being replaced are dropped. */
  write(payload: RunEventPayload): void {
    if (payload.type === "item") {
      this.deltas.delete(payload.item.id);
    } else if (payload.type !== "delta") {
      this.flushDeltas();
    }
    this.enqueue([payload]);
  }

  delta(itemId: string, delta: string): void {
    this.deltas.set(itemId, (this.deltas.get(itemId) ?? "") + delta);
    this.flushTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
  }

  private flushDeltas() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.deltas.size === 0) return;
    const payloads: RunEventPayload[] = [...this.deltas].map(([itemId, delta]) => ({
      type: "delta",
      itemId,
      delta,
    }));
    this.deltas.clear();
    this.enqueue(payloads);
  }

  private enqueue(payloads: RunEventPayload[]) {
    this.queue = this.queue
      .then(async () => {
        await this.db
          .insert(runEvents)
          .values(payloads.map((payload) => ({ runId: this.runId, chatId: this.chatId, payload })));
        this.scheduleNotify();
      })
      .catch(this.onError);
  }

  private scheduleNotify() {
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null;
      notify(this.pool, CHANNELS.chat, this.chatId).catch(this.onError);
    }, 30);
  }

  /** Wait until everything written so far is stored. */
  async drain(): Promise<void> {
    this.flushDeltas();
    await this.queue;
  }
}
