import { os } from "../../core/rpc";
import { rpcError } from "../../rpc/errors";
import type { AccountTriggers } from "./account-triggers";
import type { ScheduleService } from "./schedules";
import type { TriggerService } from "./triggers";

const ok = { ok: true } as const;

/**
 * Schedules, page watches, webhooks and account triggers, as the web app changes them, and
 * webhook calls it passes on (`workerContract.schedules`, `.triggers` and `.hooks`).
 */
export function automationRoutes(
  schedules: ScheduleService,
  triggers: TriggerService,
  accountTriggers: AccountTriggers,
) {
  return {
    schedules: {
      create: os.schedules.create.handler(async ({ input }) => ({
        id: (await schedules.create({ ...input, createdBy: "user" })).id,
      })),
      update: os.schedules.update.handler(async ({ input: { scheduleId, ...input } }) => ({
        id: (await schedules.update(scheduleId, input)).id,
      })),
      setEnabled: os.schedules.setEnabled.handler(async ({ input }) => {
        await schedules.setEnabled(input.scheduleId, input.enabled);
        return ok;
      }),
      remove: os.schedules.remove.handler(async ({ input }) => {
        await schedules.remove(input.scheduleId);
        return ok;
      }),
      runNow: os.schedules.runNow.handler(async ({ input }) => {
        await schedules.runNow(input.scheduleId);
        return ok;
      }),
    },
    triggers: {
      create: os.triggers.create.handler(async ({ input }) => {
        const row = await triggers.create(input, { kind: "user" });
        return { id: row.id, hookPath: row.token ? `/api/hooks/${row.token}` : null };
      }),
      update: os.triggers.update.handler(async ({ input: { triggerId, ...input } }) => ({
        id: (await triggers.update(triggerId, input)).id,
      })),
      setEnabled: os.triggers.setEnabled.handler(async ({ input }) => {
        await triggers.setEnabled(input.triggerId, input.enabled);
        return ok;
      }),
      remove: os.triggers.remove.handler(async ({ input }) => {
        await triggers.remove(input.triggerId);
        return ok;
      }),
      check: os.triggers.check.handler(async ({ input }) => {
        const kind = await triggers.kindOf(input.triggerId);
        return kind === "gmail" || kind === "calendar"
          ? accountTriggers.checkNow(input.triggerId)
          : triggers.checkNow(input.triggerId);
      }),
      rotateToken: os.triggers.rotateToken.handler(async ({ input }) => ({
        token: await triggers.rotateToken(input.triggerId),
      })),
    },
    hooks: {
      fire: os.hooks.fire.handler(async ({ input: { token, ...request } }) => {
        const result = await triggers.fireWebhook(token, request);
        if ("error" in result) throw rpcError(result.status, result.error);
        return result;
      }),
    },
  };
}
