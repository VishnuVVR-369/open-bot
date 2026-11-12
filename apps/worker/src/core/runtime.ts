import { errorMessage, type Logger } from "../logger";

/** A service with work of its own between start and stop, such as timers or event listeners. */
export interface Startable {
  start(): unknown;
  stop(): unknown;
}

/**
 * What runs until the worker shuts down, in the order it started. Whatever starts a timer, a
 * listener or a connection registers how to stop it here, so shutdown stops everything in reverse:
 * nothing is forgotten, and nothing stops before what still uses it.
 */
export class Runtime {
  private readonly parts: { name: string; stop: () => unknown }[] = [];
  private stopping: Promise<void> | undefined;

  constructor(private readonly log: Pick<Logger, "warn">) {}

  /** Stop with `stop` at shutdown, before everything registered earlier. */
  add(name: string, stop: () => unknown): void {
    if (this.stopping) throw new Error(`${name} started after shutdown began`);
    this.parts.push({ name, stop });
  }

  /** Start `service` now, and stop it at shutdown. */
  async start(name: string, service: Startable): Promise<void> {
    await service.start();
    this.add(name, () => service.stop());
  }

  /** Run `task` every `ms` until shutdown. */
  every(name: string, ms: number, task: () => void): void {
    const timer = setInterval(task, ms);
    timer.unref();
    this.add(name, () => clearInterval(timer));
  }

  /** Run `task` once after `ms`, unless shutdown comes first. */
  after(name: string, ms: number, task: () => void): void {
    const timer = setTimeout(task, ms);
    timer.unref();
    this.add(name, () => clearTimeout(timer));
  }

  /** Stops everything, last started first. A part that fails to stop doesn't keep the rest running. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const part of this.parts.toReversed()) {
        try {
          await part.stop();
        } catch (error) {
          this.log.warn(`${part.name} didn't stop cleanly`, { error: errorMessage(error) });
        }
      }
    })();
    return this.stopping;
  }
}
