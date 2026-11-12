/** What started a teammate's turn, in words: shown in the turn's header when it wasn't you. */
import type { RunView } from "@open-bot/api";

/** The triggers a turn names; a message from you and the end of a takeover need no label. */
export type TriggerKind = Exclude<RunView["trigger"], "user" | "takeover_ended">;

export interface TriggerLabel {
  kind: TriggerKind;
  text: string;
  /** Started by an automation, so what it gave the teammate can be shown. */
  automation: boolean;
}

const AUTOMATIONS: ReadonlySet<TriggerKind> = new Set([
  "schedule",
  "watch",
  "webhook",
  "gmail",
  "calendar",
]);

type LabeledRun = Pick<RunView, "trigger" | "scheduleTitle" | "triggerTitle" | "fromBotId">;

function text(run: LabeledRun, from: string | undefined): string | null {
  switch (run.trigger) {
    case "schedule":
      return run.scheduleTitle ?? "Scheduled task";
    case "watch":
      return run.triggerTitle ?? "Page watch";
    case "webhook":
      return run.triggerTitle ?? "Webhook";
    case "gmail":
      return run.triggerTitle ?? "New mail";
    case "calendar":
      return run.triggerTitle ?? "Calendar event";
    case "hand_back":
      return "After you handed back";
    case "approval":
      return "After your decision";
    case "handoff":
      return from ? `From ${from}` : "Handed over";
    case "question":
      return from ? `${from} asked` : "A teammate asked";
    case "answer":
      return from ? `${from} answered` : "A teammate answered";
    case "task":
      return "From the task board";
    case "email":
      return "An email";
    case "swarm":
      return "Swarm helper";
    case "swarm_results":
      return "With the helpers' results";
    case "user":
    case "takeover_ended":
      return null;
  }
}

/**
 * The label for what started a turn, or null when nothing needs saying. `teammates` names the
 * teammate a handoff, question or answer came from. Each app picks the icon for `kind`.
 */
export function triggerLabel(
  run: LabeledRun,
  teammates: readonly { id: string; name: string }[],
): TriggerLabel | null {
  const from = teammates.find((teammate) => teammate.id === run.fromBotId)?.name;
  const label = text(run, from);
  if (label === null) return null;
  const kind = run.trigger as TriggerKind;
  return { kind, text: label, automation: AUTOMATIONS.has(kind) };
}
