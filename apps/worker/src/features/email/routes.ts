import { os } from "../../core/rpc";
import type { EmailService } from "./service";

const ok = { ok: true } as const;

/**
 * Mail Postmark posts to the inbound webhook, and your email setup, as the web app asks
 * (`workerContract.email`).
 */
export function emailRoutes(email: EmailService) {
  return {
    inbound: os.email.inbound.handler(async ({ input }) => ({
      ok: true as const,
      ...(await email.inbound(input.params.token, input.body)),
    })),
    status: os.email.status.handler(() => email.status()),
    save: os.email.save.handler(async ({ input }) => {
      await email.saveSettings(input);
      return ok;
    }),
    removeToken: os.email.removeToken.handler(async () => {
      await email.removeToken();
      return ok;
    }),
  };
}
