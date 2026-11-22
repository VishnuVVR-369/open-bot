// Live progress on the phone for a run that takes a while: `run-progress` pushes, sent once the run
// has been going for a bit, then as it changes (throttled), and a last one when it ends.
import type { Context } from "../../context";
import { errorMessage } from "../../logger";
import type { NativePush } from "./fcm";
import { liveState, nativeRunProgress, type RunProgressSnapshot } from "./run-progress-push";
import type { RunProgressStore } from "./run-progress-store";

export { nativeRunProgress, type RunProgressSnapshot } from "./run-progress-push";

/** The executing run's snapshot, or null once its session is gone. */
export type RunProgressSource = (runId: string) => RunProgressSnapshot | null;

/** Where pushes go: `FcmService`. */
export interface RunProgressSender {
  readonly configured: boolean;
  /** How many phones got it, and how many sends failed and could work if tried again. */
  deliver(push: NativePush): Promise<{ sent: number; failed: number }>;
}

export interface RunProgressTiming {
  /** A run shorter than this never shows a progress notification. */
  showAfterMs: number;
  /** The least time between two updates for new steps. */
  stepEveryMs: number;
  /**
   * The least time between two updates for a status change (running, waiting on you). A target
   * for when the update is asked for: it goes once the run's previous send has been answered.
   */
  statusEveryMs: number;
  /**
   * An unchanged notification is sent again this often, so the phone's copy (which removes itself
   * when it isn't refreshed) outlives a long wait but not a lost final message.
   */
  keepAliveMs: number;
  /** After a failed end, the waits before each new try; past the last, the next start tries. */
  endRetryMs: readonly number[];
}

export const RUN_PROGRESS_TIMING: RunProgressTiming = {
  showAfterMs: 20_000,
  stepEveryMs: 15_000,
  statusEveryMs: 2_000,
  keepAliveMs: 10 * 60_000,
  endRetryMs: [30_000, 2 * 60_000, 10 * 60_000],
};

interface Tracked {
  runId: string;
  startedAt: Date;
  /** An update was asked for, so phones may show it: the run's end must be sent too. */
  shown: boolean;
  /** Saving that the end is owed, done before the first update goes. Never fails. */
  recorded: Promise<void> | null;
  /** When the last update was asked for, in ms; 0 before the first. */
  lastSentAt: number;
  /** The last update's content, to skip sending the same again. */
  lastKey: string | null;
  /** The last `sentAt` given, so a run's messages are strictly ordered for the phone. */
  lastStamp: number;
  timer: NodeJS.Timeout | null;
  /** When the timer fires, in ms. */
  due: number;
  /** The update being sent: a run has one at a time. */
  inFlight: Promise<void> | null;
  /** The newest update not sent yet, sent when `inFlight` is answered. The end drops it. */
  pending: NativePush | null;
}

/**
 * Pushes a running teammate's progress to your phones. Nothing is sent for a run that ends within
 * `showAfterMs`; after that a status change is asked for within `statusEveryMs`, new steps at most
 * every `stepEveryMs`, one at a time per run with only the newest waiting, and the run's end once.
 * Helpers (swarm runs) show nothing: their teammate's own run does.
 *
 * The end is durable: before a run's first update, the database records that its end is owed
 * (`RunProgressStore`), and the record goes only once the end was sent to every phone. A failed end
 * is tried again, and a worker that starts sends the ends still owed by runs that are over, such
 * as one stopped between storing a run's last status and sending its end, or a run the restart
 * interrupted (`executor.recover()` finishes those).
 */
export class RunProgressService {
  private readonly runs = new Map<string, Tracked>();
  /** Sends not yet answered, including ends of runs no longer tracked. */
  private readonly sending = new Set<Promise<void>>();
  /** Runs whose end is being sent, so it isn't sent twice at once. */
  private readonly ending = new Set<string>();
  /** Ends to try again, after a failure. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(
    private readonly ctx: Context,
    private readonly fcm: RunProgressSender,
    private readonly source: RunProgressSource,
    private readonly store: RunProgressStore,
    private readonly timing: RunProgressTiming = RUN_PROGRESS_TIMING,
  ) {}

  start() {
    if (!this.fcm.configured || this.started) return;
    this.started = true;
    this.ctx.events.on("runStarted", this.onStarted);
    this.ctx.events.on("runProgress", this.onProgress);
    this.ctx.events.on("runFinished", this.onFinished);
    this.track(
      this.store.overdue().then((runIds) => runIds.forEach((runId) => this.end(runId))),
      "owed ends",
    );
  }

  /** Stops listening and sending updates. Messages already being sent finish. */
  stop() {
    this.started = false;
    this.ctx.events.off("runStarted", this.onStarted);
    this.ctx.events.off("runProgress", this.onProgress);
    this.ctx.events.off("runFinished", this.onFinished);
    for (const run of this.runs.values()) if (run.timer) clearTimeout(run.timer);
    this.runs.clear();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  /** Waits until every message asked for so far has been sent (or has failed). */
  async idle(): Promise<void> {
    while (this.sending.size) await Promise.all(this.sending);
  }

  private readonly onStarted = (run: { id: string; trigger: string }) => {
    if (run.trigger === "swarm" || this.runs.has(run.id)) return;
    const tracked: Tracked = {
      runId: run.id,
      startedAt: new Date(),
      shown: false,
      recorded: null,
      lastSentAt: 0,
      lastKey: null,
      lastStamp: 0,
      timer: null,
      due: 0,
      inFlight: null,
      pending: null,
    };
    this.runs.set(run.id, tracked);
    this.schedule(tracked, this.timing.showAfterMs);
  };

  private readonly onProgress = (runId: string, change: "status" | "step") => {
    const run = this.runs.get(runId);
    // Before the first update, the timer that sends it reads the latest state anyway.
    if (!run?.shown) return;
    const every = change === "status" ? this.timing.statusEveryMs : this.timing.stepEveryMs;
    this.schedule(run, Math.max(0, run.lastSentAt + every - Date.now()));
  };

  private readonly onFinished = (run: { id: string; trigger: string }) => {
    const tracked = this.runs.get(run.id);
    if (tracked) {
      if (tracked.timer) clearTimeout(tracked.timer);
      this.runs.delete(run.id);
      // An update not sent yet is out of date now.
      tracked.pending = null;
      if (tracked.shown) this.end(run.id, tracked);
      return;
    }
    // Not seen start: a restart interrupted it. Its end is owed if it showed before.
    if (run.trigger !== "swarm") this.end(run.id);
  };

  /** Fires `update` in `delay` ms, unless it's already due sooner. */
  private schedule(run: Tracked, delay: number) {
    const due = Date.now() + delay;
    if (run.timer && run.due <= due) return;
    if (run.timer) clearTimeout(run.timer);
    run.due = due;
    run.timer = setTimeout(() => {
      run.timer = null;
      this.update(run);
    }, delay);
  }

  private update(run: Tracked) {
    if (this.runs.get(run.runId) !== run) return;
    const snapshot = this.source(run.runId);
    const state = snapshot && liveState(snapshot.status);
    // Its session is gone or done: the run's end comes with `runFinished`.
    if (!snapshot || !state) return;
    const push = nativeRunProgress({
      runId: run.runId,
      sentAt: new Date(0),
      state,
      startedAt: run.startedAt,
      snapshot,
    });
    const key = JSON.stringify(push.data);
    const now = Date.now();
    if (key !== run.lastKey || now - run.lastSentAt >= this.timing.keepAliveMs) {
      run.lastKey = key;
      run.lastSentAt = now;
      push.data.sentAt = new Date(this.stamp(run)).toISOString();
      this.enqueue(run, push);
    }
    this.schedule(run, Math.max(0, run.lastSentAt + this.timing.keepAliveMs - now));
  }

  /** A time after the run's previous message's, even when the clock steps back. */
  private stamp(run: Tracked): number {
    run.lastStamp = Math.max(Date.now(), run.lastStamp + 1);
    return run.lastStamp;
  }

  /** Sends a live update now, or after the one being sent, replacing any update still waiting. */
  private enqueue(run: Tracked, push: NativePush) {
    run.shown = true;
    run.recorded ??= this.store.shown(run.runId).catch((error: unknown) =>
      this.ctx.log.warn("couldn't save that a run's progress shows", {
        runId: run.runId,
        error: errorMessage(error),
      }),
    );
    run.pending = push;
    if (!run.inFlight) this.flush(run);
  }

  private flush(run: Tracked) {
    const push = run.pending;
    run.pending = null;
    if (!push) return;
    const sent = this.track(
      (async () => {
        await run.recorded;
        await this.fcm.deliver(push);
      })(),
      run.runId,
    );
    run.inFlight = sent;
    void sent.then(() => {
      run.inFlight = null;
      if (this.runs.get(run.runId) === run) this.flush(run);
    });
  }

  /**
   * Sends the run's end to every phone, then forgets that it's owed. A run never seen here (a
   * restart, or a retry) gets one only if the database says it's owed.
   */
  private end(runId: string, tracked?: Tracked, attempt = 0) {
    if (this.ending.has(runId)) return;
    this.ending.add(runId);
    const sentAt = tracked ? new Date(this.stamp(tracked)) : new Date();
    const ended = (async () => {
      // Saved before it's removed, so a late save can't make the end owed again.
      if (tracked) await tracked.recorded;
      else if (!(await this.store.owed(runId))) return;
      const result = await this.fcm.deliver(nativeRunProgress({ runId, sentAt, state: "ended" }));
      if (result.failed) throw new Error(`${result.failed} phones didn't get it`);
      await this.store.ended(runId);
    })();
    void this.track(
      ended.catch((error: unknown) => {
        this.retry(runId, attempt);
        throw error;
      }),
      runId,
    ).finally(() => this.ending.delete(runId));
  }

  private retry(runId: string, attempt: number) {
    const delay = this.timing.endRetryMs[attempt];
    if (!this.started || delay === undefined) return;
    clearTimeout(this.retries.get(runId));
    this.retries.set(
      runId,
      setTimeout(() => {
        this.retries.delete(runId);
        this.end(runId, undefined, attempt + 1);
      }, delay),
    );
  }

  /** Never fails: a failed push is logged. */
  private track(sent: Promise<unknown>, runId: string): Promise<void> {
    const done = sent.then(
      () => {},
      (error: unknown) =>
        this.ctx.log.warn("run progress push failed", { runId, error: errorMessage(error) }),
    );
    this.sending.add(done);
    void done.finally(() => this.sending.delete(done));
    return done;
  }
}
