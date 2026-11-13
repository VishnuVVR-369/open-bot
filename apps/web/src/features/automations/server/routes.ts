import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import {
  listAutomationRuns,
  listSchedules,
  listTriggers,
  removeSchedule,
  setCheckIn,
  testWebhook,
} from "./service";

/**
 * Schedules, page watches, webhooks and account triggers, as the browser and the phone ask
 * (`contract.schedules` and `contract.triggers`).
 */
export function automationRoutes() {
  return {
    schedules: {
      list: os.schedules.list.handler(() => listSchedules()),
      runs: os.schedules.runs.handler(({ input }) =>
        listAutomationRuns({ scheduleId: input.scheduleId }),
      ),
      create: os.schedules.create.handler(({ input }) => worker.schedules.create(input)),
      update: os.schedules.update.handler(({ input }) => worker.schedules.update(input)),
      setEnabled: os.schedules.setEnabled.handler(({ input }) =>
        worker.schedules.setEnabled(input),
      ),
      remove: os.schedules.remove.handler(({ input }) => removeSchedule(input)),
      runNow: os.schedules.runNow.handler(({ input }) => worker.schedules.runNow(input)),
      setCheckIn: os.schedules.setCheckIn.handler(({ input }) => setCheckIn(input)),
    },
    triggers: {
      list: os.triggers.list.handler(() => listTriggers()),
      runs: os.triggers.runs.handler(({ input }) =>
        listAutomationRuns({ triggerId: input.triggerId }),
      ),
      create: os.triggers.create.handler(({ input }) => worker.triggers.create(input)),
      update: os.triggers.update.handler(({ input }) => worker.triggers.update(input)),
      setEnabled: os.triggers.setEnabled.handler(({ input }) => worker.triggers.setEnabled(input)),
      remove: os.triggers.remove.handler(({ input }) => worker.triggers.remove(input)),
      // Looking at a page can take a while.
      check: os.triggers.check.handler(({ input }) =>
        worker.triggers.check(input, { context: { timeoutMs: 45_000 } }),
      ),
      rotateToken: os.triggers.rotateToken.handler(({ input }) =>
        worker.triggers.rotateToken(input),
      ),
      test: os.triggers.test.handler(({ input }) => testWebhook(input)),
    },
  };
}
