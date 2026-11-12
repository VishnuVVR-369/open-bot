import type { ComputerAction } from "../computer/protocol";
import type { AccountActionPreview } from "../integrations/accounts";
import { z } from "zod";
import type { ApprovalKind, ApprovalStatus } from "../approvals/rules";

/**
 * A run's activity, as the UI renders it.
 * The worker maps Codex notifications to these items and stores them as run events.
 */

export type ItemStatus = "running" | "completed" | "failed";

interface BaseItem {
  id: string;
  status: ItemStatus;
  startedAt: string;
  completedAt?: string;
}

export interface MessageItem extends BaseItem {
  kind: "message";
  text: string;
  /** Commentary is a progress note during work; final is the answer. */
  phase: "commentary" | "final";
}

export interface ReasoningItem extends BaseItem {
  kind: "reasoning";
  text: string;
}

export interface CommandItem extends BaseItem {
  kind: "command";
  command: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface FileChangeItem extends BaseItem {
  kind: "file_change";
  changes: { path: string; change: "add" | "delete" | "update"; diff: string }[];
}

export interface ComputerItem extends BaseItem {
  kind: "computer";
  action: ComputerAction;
  /** Artifact id of the screenshot taken after the action. */
  screenshotId?: string;
  error?: string;
}

export interface ToolItem extends BaseItem {
  kind: "tool";
  name: string;
  /** A short human label, such as "Scheduled a daily briefing". */
  label: string;
  args: unknown;
  result?: string;
  error?: string;
}

export interface PlanItem extends BaseItem {
  kind: "plan";
  steps: { step: string; status: "pending" | "inProgress" | "completed" }[];
}

export interface WebSearchItem extends BaseItem {
  kind: "web_search";
  query: string;
}

export interface ApprovalItem extends BaseItem {
  kind: "approval";
  approvalId: string;
  /** What is being approved: a shell command, a file change, or an action the bot describes. */
  approvalKind?: ApprovalKind;
  /**
   * What an "always allow" rule matches: the raw command for command approvals (by prefix), or
   * a kind of action, like "Create teammates", when the title names one instance of it.
   */
  subject?: string;
  /** Asked about every time, like giving a teammate access; no "always allow". */
  askEveryTime?: boolean;
  title: string;
  detail: string;
  decision: ApprovalStatus;
  /** For an action on one of your accounts: what will happen, exactly, to render properly. */
  preview?: AccountActionPreview;
}

export interface TakeoverRequestItem extends BaseItem {
  kind: "takeover_request";
  takeoverRequestId: string;
  reason: string;
  resolution: "pending" | "taken" | "handed_back" | "dismissed";
  note?: string;
}

export interface HandoffItem extends BaseItem {
  kind: "handoff";
  toBotId: string;
  toBotName: string;
  message: string;
}

/** A message you sent while the bot was working, which joined its current turn. */
export interface UserMessageItem extends BaseItem {
  kind: "user_message";
  text: string;
  messageId: string;
  /** `hand_back` marks the note you left when you handed the desktop back. */
  variant?: "message" | "hand_back";
}

/** How many helpers a swarm can have, each with its own screen. */
export const MAX_SWARM_TASKS = 6;

export const SWARM_TASK_STATES = ["queued", "running", "completed", "failed", "stopped"] as const;
export const swarmTaskStateSchema = z.enum(SWARM_TASK_STATES);
export type SwarmTaskState = (typeof SWARM_TASK_STATES)[number];

export const SWARM_STATES = ["running", "done", "stopped"] as const;
export type SwarmState = (typeof SWARM_STATES)[number];

/** A job split across helpers working at the same time, each on its own screen. */
export interface SwarmItem extends BaseItem {
  kind: "swarm";
  swarmId: string;
  title: string;
  state: SwarmState;
  tasks: {
    /** Also the helper's screen. */
    id: string;
    title: string;
    state: SwarmTaskState;
    chatId: string | null;
    /** The start of the helper's result, once it has one. */
    result?: string;
  }[];
}

/** A page the teammate published: a new page, or a new version of one. */
export interface PageItem extends BaseItem {
  kind: "page";
  pageId: string;
  versionId: string;
  /** 1 for a new page. */
  version: number;
  title: string;
  summary: string;
}

export interface ErrorItem extends BaseItem {
  kind: "error";
  message: string;
}

export type TimelineItem =
  | MessageItem
  | ReasoningItem
  | CommandItem
  | FileChangeItem
  | ComputerItem
  | ToolItem
  | PlanItem
  | WebSearchItem
  | ApprovalItem
  | TakeoverRequestItem
  | HandoffItem
  | UserMessageItem
  | SwarmItem
  | PageItem
  | ErrorItem;

export const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What started a run. */
export const RUN_TRIGGERS = [
  "user",
  "schedule",
  "watch",
  "webhook",
  "hand_back",
  "approval",
  "handoff",
  /** Another teammate asked this teammate something with ask_teammate. */
  "question",
  /** The answer to a question this teammate asked, coming back to it. */
  "answer",
  /** A task from the board this teammate was asked to work on. */
  "task",
  "takeover_ended",
  /** A helper working on one part of a swarm, on its own screen. */
  "swarm",
  /** A swarm's merged results, coming back to the teammate that started it. */
  "swarm_results",
  /** An email to the teammate's address. */
  "email",
  /** New mail in your Gmail matched a trigger. */
  "gmail",
  /** An event on your calendar is about to start. */
  "calendar",
] as const;
export const runTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** What a `waiting` run waits for: your answer to an approval, or a screen you took over. */
export const RUN_WAITS = ["approval", "takeover"] as const;
export const runWaitSchema = z.enum(RUN_WAITS);
export type RunWait = (typeof RUN_WAITS)[number];

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting",
] as const satisfies readonly RunStatus[];

/** How a run ended. */
export type FinishedRunStatus = Exclude<RunStatus, (typeof ACTIVE_RUN_STATUSES)[number]>;

export function isRunActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** What one stored run event contains. */
export type RunEventPayload =
  /** Insert or replace a whole item. */
  | { type: "item"; item: TimelineItem }
  /** Append streamed text to an item's `text` (message, reasoning) or `output` (command). */
  | { type: "delta"; itemId: string; delta: string }
  | { type: "status"; status: RunStatus; error?: string; waitingFor?: RunWait }
  | { type: "usage"; inputTokens: number; cachedInputTokens: number; outputTokens: number };

export interface RunTimelineState {
  status: RunStatus;
  error?: string;
  waitingFor?: RunWait;
  items: TimelineItem[];
}

/** Fold run events into what the UI shows. Pure, so the server and the client share it. */
export function applyRunEvent(state: RunTimelineState, event: RunEventPayload): RunTimelineState {
  switch (event.type) {
    case "status":
      return {
        ...state,
        status: event.status,
        error: event.error,
        waitingFor: event.status === "waiting" ? event.waitingFor : undefined,
      };
    case "item": {
      const index = state.items.findIndex((item) => item.id === event.item.id);
      if (index === -1) return { ...state, items: [...state.items, event.item] };
      const items = state.items.slice();
      items[index] = event.item;
      return { ...state, items };
    }
    case "delta": {
      const index = state.items.findIndex((item) => item.id === event.itemId);
      if (index === -1) return state;
      const item = state.items[index]!;
      let next: TimelineItem;
      if (item.kind === "message" || item.kind === "reasoning") {
        next = { ...item, text: item.text + event.delta };
      } else if (item.kind === "command") {
        next = { ...item, output: item.output + event.delta };
      } else {
        return state;
      }
      const items = state.items.slice();
      items[index] = next;
      return { ...state, items };
    }
    case "usage":
      return state;
  }
}

export function emptyTimeline(status: RunStatus = "queued"): RunTimelineState {
  return { status, items: [] };
}
