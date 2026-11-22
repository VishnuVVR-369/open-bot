/**
 * What a phone's live notification for a running teammate says. The worker builds it from the
 * run's timeline and sends it as a `run-progress` push; the phone only draws it.
 */
import type { PlanItem, RunWait, TimelineItem } from "../timeline/timeline";
import { type ToolIcon, toolDisplay } from "../timeline/tool-display";

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
  /**
   * The teammate's name, which changes only with your approval: it already titles every
   * notification about the teammate.
   */
  teammateName: string;
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

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const WAITING_BODY: Record<RunWait, string> = {
  approval: "Waiting for your approval",
  takeover: "Waiting for you on the screen",
};

/** A tool step, said by what kind of tool it is (its icon's meaning), never by its label. */
const TOOL_ACTIVITY: Record<ToolIcon, string> = {
  tool: "Using a tool",
  notification: "Sending you a notification",
  email: "Working on email",
  schedule: "Setting up an automation",
  calendar: "Working on your calendar",
  question: "Asking a teammate",
  tasks: "Updating the task board",
  suggestion: "Suggesting new instructions",
  skill: "Saving a skill",
  watch: "Setting up a page watch",
  webhook: "Setting up a webhook",
  history: "Searching past chats",
  profile: "Remembering something about you",
  key: "Using the vault",
  payment: "Working on a purchase",
  notes: "Working in Notion",
};

/** Tools that drive the computer's screen or browser, by name. */
const COMPUTER_TOOL = /^(desktop|browser)_/;

/**
 * What the teammate is doing now, for text that leaves the app: said only by the kind of step,
 * never with what the step holds. A command's line, a file's path, a search's query, a tool's
 * label (which can quote a URL, an address or a value) all stay out, since they can hold secrets.
 */
export function progressActivity(items: readonly TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    switch (item.kind) {
      case "command":
        return "Running a command";
      case "file_change":
        return item.changes.length > 1 ? `Editing ${item.changes.length} files` : "Editing a file";
      case "web_search":
        return "Searching the web";
      case "computer":
        return "Using the computer";
      case "tool":
        // The worker's note that it switched to the API key is not something the teammate does.
        if (item.name === "model_fallback") continue;
        if (COMPUTER_TOOL.test(item.name)) return "Using the computer";
        return TOOL_ACTIVITY[toolDisplay(item.name).icon];
      case "reasoning":
        return "Thinking";
      case "message":
        return item.phase === "final" ? "Writing" : null;
      default:
        continue;
    }
  }
  return null;
}

const TITLE: Record<LiveRunProgressState, string> = {
  starting: "is working",
  working: "is working",
  waiting: "is waiting for you",
};

/**
 * Every word is fixed but the teammate's name: the title says only who and in which state ("Rex is
 * working"), and the body the kind of step it's on now (`progressActivity`) or what it's waiting
 * for. The text goes through Google's push service, so nothing a model or a tool wrote reaches it:
 * not a plan step, not the chat's title, not a tool's arguments or output. The app shows those.
 */
export function runProgressNotice(input: RunProgressInput): RunProgressNotice {
  const plan = input.items.findLast(
    (item): item is PlanItem => item.kind === "plan" && item.steps.length > 0,
  );
  const body =
    input.state === "waiting"
      ? WAITING_BODY[input.waitingFor ?? "approval"]
      : input.state === "starting"
        ? "Getting ready"
        : (progressActivity(input.items) ?? "Working");
  return {
    title: clip(`${input.teammateName} ${TITLE[input.state]}`, MAX_TITLE),
    body,
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
