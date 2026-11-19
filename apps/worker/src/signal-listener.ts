import { errorFields } from "@open-bot/db";
import type pg from "pg";
import type { Logger } from "./logger";

/** The first wait before listening again after the connection fails; it doubles up to the max. */
const RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export interface SignalListenerOptions {
  pool: pg.Pool;
  /** A NOTIFY channel (`NOTIFY_CHANNELS`); it is put into the `listen` statement as is. */
  channel: string;
  onNotification(payload: string): void;
  /** Listening again after the connection failed: signals sent in between were missed. */
  onReconnect(): void;
  log: Logger;
  retryMs?: number;
}

/**
 * One connection that LISTENs on a channel for as long as the worker runs. It is a client taken
 * out of the pool and kept, which the pool no longer watches: when the database restarts or ends
 * the connection, the error reaches only this client, and with nothing listening it would end the
 * process. So a failed connection is dropped from the pool and replaced, waiting longer each time
 * a new one can't be made.
 */
export class SignalListener {
  private client: pg.PoolClient | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly retryMs: number;

  constructor(private readonly options: SignalListenerOptions) {
    this.retryMs = options.retryMs ?? RETRY_MS;
  }

  /** Listens; fails if the first connection can't be made, so the worker doesn't start deaf. */
  async start(): Promise<void> {
    await this.listen();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const client = this.client;
    this.client = null;
    client?.release();
  }

  private async listen(): Promise<void> {
    const client = await this.options.pool.connect();
    let failed = false;
    // Before the first query, so a failure during it is heard too.
    client.on("error", (error) => {
      if (failed) return;
      failed = true;
      this.options.log.warn("signal connection failed", errorFields(error));
      if (this.client === client) this.client = null;
      // Passing the error makes the pool close the connection instead of handing it out again.
      client.release(error);
      this.scheduleRetry(this.retryMs);
    });
    client.on("notification", (message) => {
      if (message.payload) this.options.onNotification(message.payload);
    });
    try {
      await client.query(`listen ${this.options.channel}`);
    } catch (error) {
      if (!failed) {
        failed = true;
        client.release(error instanceof Error ? error : true);
      }
      throw error;
    }
    if (failed) throw new Error("The signal connection failed while it started listening.");
    if (this.stopped) {
      client.release();
      return;
    }
    this.client = client;
  }

  private scheduleRetry(ms: number) {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.stopped) return;
      this.listen().then(
        () => {
          if (this.stopped || !this.client) return;
          this.options.log.info("listening for signals again");
          this.options.onReconnect();
        },
        (error: unknown) => {
          this.options.log.warn("listening for signals again failed", errorFields(error));
          this.scheduleRetry(Math.min(ms * 2, MAX_RETRY_MS));
        },
      );
    }, ms);
    this.retry.unref();
  }
}
