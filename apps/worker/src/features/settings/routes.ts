import { os } from "../../core/rpc";
import type { SettingsService } from "./service";

const ok = { ok: true } as const;

/** The settings procedures in the worker's internal API. */
export function settingsRoutes(settings: SettingsService) {
  return {
    setTimezone: os.settings.setTimezone.handler(async ({ input }) => {
      await settings.setTimezone(input.timezone);
      return ok;
    }),
    setMonthlyCap: os.settings.setMonthlyCap.handler(async ({ input }) => {
      await settings.setMonthlyCap(input.dollars);
      return ok;
    }),
    saveApiKey: os.settings.saveApiKey.handler(async ({ input }) => {
      await settings.saveApiKey(input.apiKey);
      return ok;
    }),
    removeApiKey: os.settings.removeApiKey.handler(async () => {
      await settings.removeApiKey();
      return ok;
    }),
  };
}
