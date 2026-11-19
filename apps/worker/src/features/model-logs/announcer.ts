// Tells open tabs that model logs were saved, so the runs list shows a run once its first turn
// is saved and its totals once its last requests are. The writer saves in batches about once a
// second while a run works, so the news goes out at most once per interval, and always after the
// batch that prompted it was committed. At shutdown it stops after the writer has drained, and
// announces what that drain saved before it goes.

/** What the announcer listens to: the writer's `written`, after each committed batch. */
export interface SavedLogs {
  on(event: "written", listener: () => void): unknown;
  off(event: "written", listener: () => void): unknown;
}

/** The least time between two announcements. */
export const ANNOUNCE_EVERY_MS = 2_000;

export class ModelLogAnnouncer {
  private timer: NodeJS.Timeout | null = null;
  private last = -Infinity;
  /** The announcement being sent, if one is. */
  private sending: Promise<void> | null = null;
  private readonly onWritten = () => this.poke();

  constructor(
    private readonly writer: SavedLogs,
    private readonly announce: () => Promise<void>,
    private readonly everyMs = ANNOUNCE_EVERY_MS,
  ) {}

  start(): void {
    this.writer.on("written", this.onWritten);
  }

  /**
   * Stops listening, then sends the announcement still waiting for its interval, if any, and
   * waits for the one being sent: what the writer saved last is announced too.
   */
  async stop(): Promise<void> {
    this.writer.off("written", this.onWritten);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.send();
    }
    await this.sending;
  }

  /**
   * A batch was committed: announce it now, or, within `everyMs` of the last announcement, once
   * that time is up. Saves meanwhile ride along with the one already scheduled.
   */
  private poke(): void {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.send();
      },
      Math.max(0, this.last + this.everyMs - Date.now()),
    );
    this.timer.unref();
  }

  private send(): void {
    this.last = Date.now();
    const sending = this.announce()
      .catch(() => {})
      .finally(() => {
        if (this.sending === sending) this.sending = null;
      });
    this.sending = sending;
  }
}
