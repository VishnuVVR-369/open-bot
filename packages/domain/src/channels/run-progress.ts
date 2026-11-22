/**
 * What a phone's live notification for a running teammate says. The worker builds it from the
 * run's timeline and sends it as a `run-progress` push; the phone only draws it.
 */
import { currentActivity } from "../timeline/activity";
import type { PlanItem, RunWait, TimelineItem } from "../timeline/timeline";

/** Where a run is, as its progress notification shows it. `ended` removes the notification. */
export const RUN_PROGRESS_STATES = ["starting", "working", "waiting", "ended"] as const;
export type RunProgressState = (typeof RUN_PROGRESS_STATES)[number];
/** The states that show a notification. */
export type LiveRunProgressState = Exclude<RunProgressState, "ended">;

/**
 * The id of a run's progress notification. A result about the same run uses the run's own id, so
 * the two never replace each other.
 */
export function runProgressTag(runId: string): string {
  return `run-progress:${runId}`;
}

export interface RunProgressInput {
  teammateName: string;
  /** The chat's title, only when it says what the chat is about (`chats.titled`). */
  chatTitle: string | null;
  state: LiveRunProgressState;
  waitingFor?: RunWait | null;
  items: readonly TimelineItem[];
}

export interface RunProgressNotice {
  title: string;
  body: string;
  /** The teammate's plan, when it made one: how many of its steps are done. */
  steps?: { done: number; total: number };
}

const MAX_TITLE = 80;
const MAX_BODY = 120;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const WAITING_BODY: Record<RunWait, string> = {
  approval: "Waiting for your approval",
  takeover: "Waiting for you on the screen",
};

/**
 * The title names the teammate and what it's working on: the plan step in progress, or the chat's
 * title. The body is the step it's on now, or what it's waiting for. Commands name only their
 * program, since the text goes through Google's push service.
 */
export function runProgressNotice(input: RunProgressInput): RunProgressNotice {
  const plan = input.items.findLast(
    (item): item is PlanItem => item.kind === "plan" && item.steps.length > 0,
  );
  const step = plan?.steps.find((entry) => entry.status === "inProgress")?.step.trim();
  const about = step || input.chatTitle?.trim();
  const name = input.teammateName;
  const title = about
    ? `${name}: ${about}`
    : input.state === "waiting"
      ? `${name} is waiting for you`
      : `${name} is working`;
  const body =
    input.state === "waiting"
      ? WAITING_BODY[input.waitingFor ?? "approval"]
      : input.state === "starting"
        ? "Getting ready"
        : (currentActivity(input.items, { command: "program" }) ?? "Working");
  return {
    title: clip(title, MAX_TITLE),
    body: clip(body, MAX_BODY),
    ...(plan
      ? {
          steps: {
            done: plan.steps.filter((entry) => entry.status === "completed").length,
            total: plan.steps.length,
          },
        }
      : {}),
  };
}
