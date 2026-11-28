import type { ScheduleView, TriggerView } from "@open-bot/api";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage, isRetryable } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { queryClient, queryKeys } from "@/lib/query";
import { checkOutcome, deleteText, RetryKeys, runNowOutcome, type Automation } from "./automations";
import { setEnabledOptimistically } from "./optimistic";

const listKey = (automation: Pick<Automation, "type">) =>
  automation.type === "schedule" ? queryKeys.schedules : queryKeys.triggers;

/** Reads the list and the automation's history again, from the server. */
function refresh(automation: Pick<Automation, "type" | "id">) {
  void queryClient.invalidateQueries({ queryKey: listKey(automation) });
  void queryClient.invalidateQueries({
    queryKey:
      automation.type === "schedule"
        ? queryKeys.scheduleRuns(automation.id)
        : queryKeys.triggerRuns(automation.id),
  });
}

/**
 * The ids of a screen's "Run now" taps, kept for retries until each is answered, so a lost answer
 * runs once. A screen makes its own, so leaving it forgets them, as a short wait does too.
 */
export const newRunKeys = () => new RetryKeys(() => Crypto.randomUUID());

/**
 * Turns it on or off, showing the switch where you put it at once. A refusal (a reminder whose
 * time has passed can't be turned on) says why and puts the switch back.
 */
export async function setAutomationEnabled(automation: Automation, enabled: boolean) {
  haptics.tap();
  const error = await setEnabledOptimistically(
    queryClient,
    listKey(automation),
    automation.id,
    enabled,
    () =>
      safe(
        automation.type === "schedule"
          ? api.schedules.setEnabled({ scheduleId: automation.id, enabled })
          : api.triggers.setEnabled({ triggerId: automation.id, enabled }),
      ),
  );
  refresh(automation);
  if (error) {
    haptics.error();
    Alert.alert(enabled ? "Couldn't turn it on" : "Couldn't turn it off", errorMessage(error));
  }
}

/** What a "Run now" or "Check now" leads to, said on the automation's screen. */
export interface ActionOutcome {
  title: string;
  body: string | null;
  failed: boolean;
  /** The run a "Run now" started, or found an earlier tap had. */
  runId?: string;
}

/**
 * Runs a schedule now, without changing when it runs next. A retry soon after a failure sends the
 * same run id, so a run whose answer was lost isn't started twice, and the answer says whether
 * this tap started it or an earlier one had (a resend of this same tap is still this tap).
 */
export async function runScheduleNow(
  schedule: Pick<ScheduleView, "id" | "title">,
  teammateName: string,
  runKeys: RetryKeys,
): Promise<ActionOutcome> {
  const retried = runKeys.retries(schedule.id);
  const runId = runKeys.for(schedule.id);
  const result = await safe(api.schedules.runNow({ scheduleId: schedule.id, runId }));
  refresh({ type: "schedule", id: schedule.id });
  if (result.error) {
    // Refused (it was deleted, say), so nothing ran: the next tap is a new ask. A dropped
    // connection or a failed server may have started it, so trying again sends the same id.
    if (!isRetryable(result.error)) runKeys.done(schedule.id);
    haptics.error();
    return { title: "Couldn't run it", body: errorMessage(result.error), failed: true };
  }
  runKeys.done(schedule.id);
  haptics.success();
  return { ...runNowOutcome(schedule, result.data, teammateName, retried), runId };
}

/** Looks at the page, mail or calendar now, and says what it found. */
export async function checkTriggerNow(
  trigger: Pick<TriggerView, "id" | "kind" | "title">,
  teammateName: string,
): Promise<ActionOutcome> {
  const result = await safe(api.triggers.check({ triggerId: trigger.id }));
  refresh({ type: "trigger", id: trigger.id });
  if (result.error) {
    haptics.error();
    return {
      ...checkOutcome(trigger, { ok: false, changed: false, summary: "" }, teammateName),
      body: errorMessage(result.error),
    };
  }
  const outcome = checkOutcome(trigger, result.data, teammateName);
  if (outcome.failed) haptics.error();
  else haptics.success();
  return outcome;
}

/** Asks, then deletes it, as the web does. Past runs stay in their chats. */
export function confirmDeleteAutomation(automation: Automation, onDeleted?: () => void) {
  haptics.warning();
  Alert.alert(`Delete “${automation.title}”?`, deleteText(automation), [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const result = await safe(
          automation.type === "schedule"
            ? api.schedules.remove({ scheduleId: automation.id })
            : api.triggers.remove({ triggerId: automation.id }),
        );
        if (result.error) {
          haptics.error();
          Alert.alert("Couldn't delete it", errorMessage(result.error));
          return;
        }
        haptics.success();
        onDeleted?.();
        animateLayout();
        queryClient.setQueryData<(ScheduleView | TriggerView)[]>(listKey(automation), (current) =>
          current?.filter((entry) => entry.id !== automation.id),
        );
        refresh(automation);
      },
    },
  ]);
}

/**
 * Turns a teammate's daily check-in on or off. Turning it on resumes a paused one rather than
 * adding another; the switch follows the list once it's read again.
 */
export async function setDailyCheckIn(teammateId: string, on: boolean): Promise<boolean> {
  haptics.tap();
  const result = await safe(api.schedules.setCheckIn({ teammateId, on }));
  await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
  if (result.error) {
    haptics.error();
    Alert.alert(
      on ? "Couldn't turn the check-in on" : "Couldn't turn the check-in off",
      errorMessage(result.error),
    );
    return false;
  }
  return true;
}
