// Live progress on the phone for a run that takes a while: `run-progress` pushes, sent once the run
// has been going for a bit, then as it changes (throttled), and a last one when it ends.
import {
  type LiveRunProgressState,
  type RunStatus,
  type RunWait,
  type TimelineItem,
  runProgressNotice,
  runProgressTag,
} from "@open-bot/domain";
import type { Context } from "../../context";
import { errorMessage } from "../../logger";
import type { NativePush } from "./fcm";

/** What a running session tells the progress notification (`RunSession.progress()`). */
export interface RunProgressSnapshot {
  teammateId: string;
  teammateName: string;
  chatId: string;
  /** The chat's title, only when it says what the chat is about. */
  chatTitle: string | null;
  status: RunStatus;
  waitingFor: RunWait | null;
  items: readonly TimelineItem[];
}

/** The executing run's snapshot, or null once its session is gone. */
export type RunProgressSource = (runId: string) => RunProgressSnapshot | null;

/** Where pushes go: `FcmService`. */
export interface RunProgressSender {
  readonly configured: boolean;
  sendAll(push: NativePush): Promise<number>;
}

export interface RunProgressTiming {
  /** A run shorter than this never shows a progress notification. */
  showAfterMs: number;
  /** The least time between two updates for new steps. */
  stepEveryMs: number;
  /** The least time between two updates for a status change (running, waiting on you). */
  statusEveryMs: number;
  /**
   * An unchanged notification is sent again this often, so the phone's copy (which removes itself
   * when it isn't refreshed) outlives a long wait but not a lost final message.
   */
  keepAliveMs: number;
}

export const RUN_PROGRESS_TIMING: RunProgressTiming = {
  showAfterMs: 20_000,
  stepEveryMs: 15_000,
  statusEveryMs: 2_000,
  keepAliveMs: 10 * 60_000,
};

/** How long an update is worth delivering, and how long the last message is (it removes one). */
const LIVE_TTL_SECONDS = 10 * 60;
const ENDED_TTL_SECONDS = 24 * 60 * 60;

/** A run's progress message. Each run's messages collapse into its latest at FCM. */
export function nativeRunProgress(input: {
  runId: string;
  sentAt: Date;
  state: LiveRunProgressState | "ended";
  startedAt?: Date;
  snapshot?: RunProgressSnapshot;
}): NativePush {
  const { runId, snapshot } = input;
  const notice =
    snapshot && input.state !== "ended"
      ? runProgressNotice({
          teammateName: snapshot.teammateName,
          chatTitle: snapshot.chatTitle,
          state: input.state,
          waitingFor: snapshot.waitingFor,
          items: snapshot.items,
        })
      : null;
  return {
    data: {
      type: "run-progress",
      tag: runProgressTag(runId),
      runId,
      runState: input.state,
      sentAt: input.sentAt.toISOString(),
      ...(snapshot
        ? {
            chatId: snapshot.chatId,
            teammateId: snapshot.teammateId,
            url: `/chats/${snapshot.chatId}?run=${runId}`,
          }
        : {}),
      ...(input.startedAt ? { startedAt: input.startedAt.toISOString() } : {}),
      ...(notice
        ? {
            title: notice.title,
            body: notice.body,
            ...(notice.steps
              ? { stepsDone: String(notice.steps.done), stepsTotal: String(notice.steps.total) }
              : {}),
          }
        : {}),
    },
    priority: "normal",
    collapseKey: `run-progress-${runId}`,
    ttlSeconds: input.state === "ended" ? ENDED_TTL_SECONDS : LIVE_TTL_SECONDS,
  };
}

function liveState(status: RunStatus): LiveRunProgressState | null {
  if (status === "starting") return "starting";
  if (status === "running") return "working";
  if (status === "waiting") return "waiting";
  return null;
}

interface Tracked {
  runId: string;
  startedAt: Date;
  /** An update was sent, so the phone may show one: the run's end must be sent too. */
  shown: boolean;
  /** When the last update was sent, in ms; 0 before the first. */
  lastSentAt: number;
  /** The last update's content, to skip sending the same again. */
  lastKey: string | null;
  /** The last `sentAt` given, so a run's messages are strictly ordered for the phone. */
  lastStamp: number;
  timer: NodeJS.Timeout | null;
  /** When the timer fires, in ms. */
  due: number;
  /** Sends, one after another, so the end is always the last request made. */
  chain: Promise<void>;
}

/**
 * Pushes a running teammate's progress to your phones. Nothing is sent for a run that ends within
 * `showAfterMs`; after that a status change is sent within `statusEveryMs`, new steps at most every
 * `stepEveryMs`, and the run's end once, after every update, removes the notification. Helpers
 * (swarm runs) show nothing: their teammate's own run does. After a restart, runs the restart
 * interrupted get their end too, since the phone may still show them.
 */
export class RunProgressService {
  private readonly runs = new Map<string, Tracked>();
  /** Sends not yet answered, including ends of runs no longer tracked. */
  private readonly sending = new Set<Promise<void>>();
  private started = false;

  constructor(
    private readonly ctx: Context,
    private readonly fcm: RunProgressSender,
    private readonly source: RunProgressSource,
    private readonly timing: RunProgressTiming = RUN_PROGRESS_TIMING,
  ) {}

  start() {
    if (!this.fcm.configured || this.started) return;
    this.started = true;
    this.ctx.events.on("runStarted", this.onStarted);
    this.ctx.events.on("runProgress", this.onProgress);
    this.ctx.events.on("runFinished", this.onFinished);
  }

  /** Stops listening and sending updates. Messages already being sent finish. */
  stop() {
    this.started = false;
    this.ctx.events.off("runStarted", this.onStarted);
    this.ctx.events.off("runProgress", this.onProgress);
    this.ctx.events.off("runFinished", this.onFinished);
    for (const run of this.runs.values()) if (run.timer) clearTimeout(run.timer);
    this.runs.clear();
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
      lastSentAt: 0,
      lastKey: null,
      lastStamp: 0,
      timer: null,
      due: 0,
      chain: Promise.resolve(),
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
      if (tracked.shown) this.send(tracked, nativeRunProgress(this.ended(tracked)));
      return;
    }
    // Not seen start: interrupted by a restart, when its notification may still be showing.
    if (run.trigger === "swarm") return;
    this.deliver(nativeRunProgress({ runId: run.id, sentAt: new Date(), state: "ended" }));
  };

  private ended(run: Tracked) {
    return { runId: run.runId, sentAt: new Date(this.stamp(run)), state: "ended" as const };
  }

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
      run.shown = true;
      push.data.sentAt = new Date(this.stamp(run)).toISOString();
      this.send(run, push);
    }
    this.schedule(run, Math.max(0, run.lastSentAt + this.timing.keepAliveMs - now));
  }

  /** A time after the run's previous message's, even when the clock steps back. */
  private stamp(run: Tracked): number {
    run.lastStamp = Math.max(Date.now(), run.lastStamp + 1);
    return run.lastStamp;
  }

  private send(run: Tracked, push: NativePush) {
    run.chain = this.track(
      run.chain.then(() => this.fcm.sendAll(push)),
      push,
    );
  }

  private deliver(push: NativePush) {
    void this.track(this.fcm.sendAll(push), push);
  }

  /** Never fails: a failed push is logged, and the run's next message still goes after it. */
  private track(sent: Promise<unknown>, push: NativePush): Promise<void> {
    const done = sent.then(
      () => {},
      (error: unknown) =>
        this.ctx.log.warn("run progress push failed", {
          runId: push.data.runId,
          error: errorMessage(error),
        }),
    );
    this.sending.add(done);
    void done.finally(() => this.sending.delete(done));
    return done;
  }
}
