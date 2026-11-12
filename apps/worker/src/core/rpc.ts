import { workerContract } from "@open-bot/api/worker";
import { implement } from "@orpc/server";

/** Per request: the path, which names what keeps the computer awake while it runs. */
export interface RpcContext {
  path: string;
}

/** Implements `workerContract`'s procedures. Each feature's routes.ts implements its own part. */
export const os = implement(workerContract).$context<RpcContext>();
