import type { Feature } from "../../core/feature";
import type { AccountTriggers } from "./account-triggers";
import type { ScheduleService } from "./schedules";
import type { TriggerService } from "./triggers";

type Loop = { start(): unknown; stop(): unknown; kick(): void };

/**
 * Automations' background work: the scheduler, page watches and webhooks, and Gmail and Calendar
 * triggers, each a loop that ticks on a timer and when the web app changes one.
 */
export function automationsFeature(services: {
  schedules: Pick<ScheduleService, keyof Loop>;
  triggers: Pick<TriggerService, keyof Loop>;
  accountTriggers: Pick<AccountTriggers, keyof Loop>;
}): Feature<"schedules" | "triggers"> {
  const { schedules, triggers, accountTriggers } = services;
  return {
    name: "automations",
    async start(runtime) {
      await runtime.start("schedules", schedules);
      await runtime.start("triggers", triggers);
      await runtime.start("account triggers", accountTriggers);
    },
    signals: {
      schedules: () => schedules.kick(),
      // The web app sends one signal for every kind of trigger.
      triggers: () => {
        triggers.kick();
        accountTriggers.kick();
      },
    },
  };
}
