import type { Context } from "../../context";
import { os } from "../../core/rpc";
import { withScreenLock } from "./screen-lock";
import type { ScreenOperationService } from "./screen-operations";
import type { TakeoverService } from "./takeovers";

const ok = { ok: true } as const;

/** Finds a teammate by id: a screen's id is its teammate's. */
interface ScreenOwners {
  findTeammate(id: string): Promise<{ id: string }>;
}

/**
 * Screens, taking one over and handing it back, and what you type on one, as the web app asks
 * (`workerContract.screens`, `.screenOperations` and `.takeovers`).
 */
export function screenRoutes(
  ctx: Pick<Context, "computer" | "pool">,
  teammates: ScreenOwners,
  takeovers: TakeoverService,
  screenOperations: ScreenOperationService,
) {
  /** A screen is a teammate's, so its id must be one. */
  const screenOf = async (id: string) => (await teammates.findTeammate(id)).id;
  return {
    screens: {
      wake: os.screens.wake.handler(async ({ input }) => {
        await ctx.computer.startScreen(await screenOf(input.screenId));
        return ok;
      }),
      forget: os.screens.forget.handler(async ({ input }) => {
        await ctx.computer.forgetScreen(await screenOf(input.screenId));
        return ok;
      }),
      take: os.screens.take.handler(async ({ input }) => {
        const id = await screenOf(input.screenId);
        await withScreenLock(ctx, id, () => takeovers.take(id));
        return ok;
      }),
      handBack: os.screens.handBack.handler(async ({ input }) => {
        const id = await screenOf(input.screenId);
        await withScreenLock(ctx, id, () =>
          takeovers.handBack(id, input.note ?? null, input.clearCode),
        );
        return ok;
      }),
      touch: os.screens.touch.handler(async ({ input }) => {
        await ctx.computer.touchUser(await screenOf(input.screenId));
        return ok;
      }),
      typeCode: os.screens.typeCode.handler(({ input }) => screenOperations.type(input)),
    },
    screenOperations: {
      get: os.screenOperations.get.handler(({ input }) => screenOperations.get(input.operationId)),
      cancel: os.screenOperations.cancel.handler(({ input }) =>
        screenOperations.cancel(input.operationId),
      ),
    },
    takeovers: {
      codeContext: os.takeovers.codeContext.handler(({ input }) =>
        screenOperations.context(input.takeoverId),
      ),
      dismiss: os.takeovers.dismiss.handler(async ({ input }) => {
        await takeovers.dismiss(input.takeoverId);
        return ok;
      }),
    },
  };
}
