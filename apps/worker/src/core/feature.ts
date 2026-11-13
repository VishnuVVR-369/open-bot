import type { WorkerSignal } from "@open-bot/domain";
import type { Runtime } from "./runtime";

/** What a feature registers its background work on, so shutdown stops each part, in reverse. */
export type FeatureRuntime = Pick<Runtime, "add" | "start" | "every" | "after">;

/**
 * A feature as the worker's entry point runs it: the background work it starts, and the signals
 * from the web app (`NOTIFY openbot_worker`) it answers. `index.ts` starts features in a fixed
 * order, and the Runtime stops what each registered in reverse. `Signal` names the signals it
 * answers, so `index.ts` still fails to compile while a signal has no handler.
 */
export interface Feature<Signal extends WorkerSignal = never> {
  name: string;
  start(runtime: FeatureRuntime): Promise<void>;
  signals: Record<Signal, () => void>;
}
