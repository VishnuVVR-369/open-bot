import { os } from "../../core/rpc";
import type { SwarmService } from "./service";

const ok = { ok: true } as const;

/** The teamwork procedures in the worker's internal API. */
export function swarmRoutes(swarms: SwarmService) {
  return {
    stop: os.swarms.stop.handler(async ({ input }) => {
      await swarms.stop(input.swarmId);
      return ok;
    }),
  };
}
