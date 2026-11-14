import type { Context } from "../../context";
import { os } from "../../core/rpc";
import type { CodexAccountService } from "./service";

const ok = { ok: true } as const;

/** The codex-account procedures in the worker's internal API. */
export function codexAccountRoutes(ctx: Pick<Context, "codex">, codexAccount: CodexAccountService) {
  return {
    deviceLogin: os.codex.deviceLogin.handler(() => ctx.codex.startDeviceLogin()),
    setAuthSource: os.codex.setAuthSource.handler(({ input }) =>
      codexAccount.setAuthSource(input.source),
    ),
    logout: os.codex.logout.handler(async () => {
      await codexAccount.logout();
      return ok;
    }),
    rateLimits: os.codex.rateLimits.handler(async () => {
      const limits = await ctx.codex.rateLimits();
      if (!limits) return { rateLimits: null };
      const { primary, secondary } = limits.rateLimits;
      return { rateLimits: { rateLimits: { primary, secondary } } };
    }),
  };
}
