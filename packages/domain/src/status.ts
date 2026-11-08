import { isRunActive, type RunStatus } from "./timeline";

/**
 * The words for a teammate's status, the same on every surface and on the web and the phone: the
 * sidebar, Home, the computer's screen list and the chat header. The line under a teammate's name
 * says only this, never their job.
 */
export const STATUS = {
  approval: "Needs your approval",
  takeover: "Needs you to take over",
  working: "Working",
  /** Online, but waiting for a free turn on the computer. */
  upNext: "Up next",
  /** The computer is offline, so the work they have can't move. Only ever means that. */
  paused: "Paused",
  idle: "Idle",
} as const;

export type StatusLabel = (typeof STATUS)[keyof typeof STATUS];

/**
 * What a teammate is up to, which their avatar's light shows. `waiting` is waiting for you;
 * `paused` is waiting for the offline computer.
 */
export type TeammateActivity = "idle" | "working" | "paused" | "waiting" | "queued";

/** The run a teammate is on, as the API's teammate summary carries it. */
export interface ActiveRunFacts {
  chatId: string;
  status: RunStatus;
  waitingFor: "approval" | "takeover" | null;
}

export interface TeammateStatus {
  /** The words under their name. */
  label: StatusLabel;
  /** For their avatar's light. */
  activity: TeammateActivity;
  /** They are waiting on you: the line turns amber. */
  needsYou: boolean;
}

function labelFor(activity: TeammateActivity, waitingFor: ActiveRunFacts["waitingFor"]) {
  switch (activity) {
    case "waiting":
      return waitingFor === "takeover" ? STATUS.takeover : STATUS.approval;
    case "paused":
      return STATUS.paused;
    case "working":
      return STATUS.working;
    case "queued":
      return STATUS.upNext;
    case "idle":
      return STATUS.idle;
  }
}

/**
 * What a teammate is doing, for lists of teammates (the sidebar, Home, the computer's screens).
 * Something waiting on you comes first, offline or not: it is yours to resolve, and you can, in a
 * chat or on the approvals page. Everyone else is paused while the computer is offline.
 */
export function teammateStatus(
  bot: { activeRun: ActiveRunFacts | null },
  computerOnline = true,
): TeammateStatus {
  const run = bot.activeRun;
  const activity: TeammateActivity =
    run?.status === "waiting"
      ? "waiting"
      : !computerOnline
        ? "paused"
        : !run
          ? "idle"
          : run.status === "queued"
            ? "queued"
            : "working";
  return {
    label: labelFor(activity, run?.waitingFor ?? null),
    activity,
    needsYou: activity === "waiting",
  };
}

/** A chat, as far as naming it goes. */
export interface ChatNaming {
  kind: "direct" | "group" | "scheduled" | "helper" | "inbox";
  title: string;
}

/** A chat's name in a sentence: "in Book the Lisbon flights", "in a scheduled task". */
export function chatPlace(chat: ChatNaming | null | undefined): string {
  if (!chat) return "another chat";
  switch (chat.kind) {
    case "scheduled":
      return "a scheduled task";
    case "inbox":
      return "their email";
    case "helper":
      return "a helper's chat";
    default:
      return chat.title.trim() || "another chat";
  }
}

export interface ChatStatus extends TeammateStatus {
  /**
   * The teammate is waiting on you in a different chat: what for and where, for a small link in
   * the header ("1 approval in Book the Lisbon flights") so this chat doesn't claim it.
   */
  elsewhere: {
    chatId: string;
    waitingFor: "approval" | "takeover";
    /** "1 approval in Book the Lisbon flights" */
    label: string;
    /** "1 approval waiting", where the chat's name doesn't fit, like a phone's header. */
    short: string;
  } | null;
}

/**
 * A direct chat's header status: what is happening in this chat, not what the teammate is doing
 * somewhere else. A run here that waits on you needs you; one that is moving is working, or paused
 * while the computer is offline; otherwise the chat is idle. The connection itself is said
 * separately (the header's "Computer offline" chip), so an idle chat doesn't say "Paused".
 *
 * When the teammate is waiting on you in another chat, `elsewhere` says so, with that chat's name
 * from `chatById`.
 */
export function chatStatus({
  bot,
  chatId,
  computerOnline,
  chatById,
}: {
  bot: { activeRun: ActiveRunFacts | null };
  chatId: string;
  computerOnline: boolean;
  chatById: (id: string) => ChatNaming | null | undefined;
}): ChatStatus {
  const run = bot.activeRun;
  const here = run && run.chatId === chatId && isRunActive(run.status) ? run : null;
  const status = teammateStatus({ activeRun: here }, computerOnline);
  // Offline with nothing running here is idle: there is nothing in this chat to pause.
  const own: TeammateStatus =
    !here && status.activity === "paused"
      ? { label: STATUS.idle, activity: "idle", needsYou: false }
      : status;
  const what = run?.waitingFor === "takeover" ? "1 takeover" : "1 approval";
  const elsewhere =
    run && run.chatId !== chatId && run.status === "waiting"
      ? {
          chatId: run.chatId,
          waitingFor: run.waitingFor === "takeover" ? ("takeover" as const) : ("approval" as const),
          label: `${what} in ${chatPlace(chatById(run.chatId))}`,
          short: `${what} waiting`,
        }
      : null;
  return { ...own, elsewhere };
}
