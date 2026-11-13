import { WORKER_SIGNALS, type WorkerSignal } from "@open-bot/domain";
import type { Runtime } from "./runtime";

/** What a feature registers its background work on, so shutdown stops each part, in reverse. */
export type FeatureRuntime = Pick<Runtime, "add" | "start" | "every" | "after">;

/**
 * A feature as the worker's entry point runs it: the background work it starts, and the signals
 * from the web app (`NOTIFY openbot_worker`) it answers. `index.ts` starts features in a fixed
 * order, and the Runtime stops what each registered in reverse. `Signal` names the signals it
 * answers; `signalHandlers` puts them together with the rest.
 */
export interface Feature<Signal extends WorkerSignal = never> {
  name: string;
  start(runtime: FeatureRuntime): Promise<void>;
  signals: Record<Signal, () => void>;
}

type Handler = () => void;

/** The signals a feature answers. */
type SignalsOf<F> = F extends Feature<infer Signal> ? Signal : never;

/**
 * Every signal's one handler: the features' and `own`, the ones `index.ts` answers itself. `own`
 * must answer exactly the signals no feature does, or it doesn't compile; a signal two features
 * answer, or none, throws, so the worker doesn't start with one handler hiding another.
 */
export function signalHandlers<const Features extends readonly Feature<never>[]>(
  features: Features,
  own: Record<Exclude<WorkerSignal, SignalsOf<Features[number]>>, Handler>,
): Record<WorkerSignal, Handler> {
  const handlers = new Map<string, { owner: string; handle: Handler }>();
  const sources: [string, Record<string, Handler>][] = [
    ...features.map((feature): [string, Record<string, Handler>] => [
      `the ${feature.name} feature`,
      feature.signals,
    ]),
    ["index.ts", own],
  ];
  for (const [owner, signals] of sources)
    for (const [signal, handle] of Object.entries(signals)) {
      const taken = handlers.get(signal);
      if (taken)
        throw new Error(`The ${signal} signal is answered by both ${taken.owner} and ${owner}.`);
      handlers.set(signal, { owner, handle });
    }
  const missing = WORKER_SIGNALS.filter((signal) => !handlers.has(signal));
  if (missing.length) throw new Error(`Nothing answers the ${missing.join(", ")} signal.`);
  return Object.fromEntries(
    WORKER_SIGNALS.map((signal) => [signal, handlers.get(signal)!.handle]),
  ) as Record<WorkerSignal, Handler>;
}
