// A run's `run-progress` push, as `RunProgressService` sends it to phones.
import {
  type LiveRunProgressState,
  type RunStatus,
  type RunWait,
  type TimelineItem,
  runProgressNotice,
  runProgressTag,
} from "@open-bot/domain";
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

/** How long an update is worth delivering, and how long the last message is (it removes one). */
const LIVE_TTL_SECONDS = 10 * 60;
const ENDED_TTL_SECONDS = 24 * 60 * 60;

/**
 * A run's progress message. Live updates collapse into the run's latest at FCM: only the newest
 * matters, and each is best effort. The end has no collapse key: FCM keeps only a few collapse
 * keys per phone while it can't deliver, and may drop any of them, but the end must arrive. The
 * phone orders a run's messages by `sentAt` and keeps an end for good, so either may come first.
 * The text is `runProgressNotice`'s, which never carries a tool's arguments or output.
 */
export function nativeRunProgress(input: {
  runId: string;
  sentAt: Date;
  state: LiveRunProgressState | "ended";
  startedAt?: Date;
  snapshot?: RunProgressSnapshot;
}): NativePush {
  const { runId, snapshot } = input;
  const ended = input.state === "ended";
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
    ...(ended ? {} : { collapseKey: `run-progress-${runId}` }),
    ttlSeconds: ended ? ENDED_TTL_SECONDS : LIVE_TTL_SECONDS,
  };
}

/** The notification's state for a run's status, or null once it's over. */
export function liveState(status: RunStatus): LiveRunProgressState | null {
  if (status === "starting") return "starting";
  if (status === "running") return "working";
  if (status === "waiting") return "waiting";
  return null;
}
