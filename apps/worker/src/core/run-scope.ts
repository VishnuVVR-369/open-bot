// The run the current async work is for. A run's session executes inside its scope, so what it asks
// of Codex (starting or forking its thread, starting its turn) is known to be the run's, even
// before Codex has named a thread the run can be found by.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

/** Runs `work` for this run: anything it starts, awaits or schedules is inside the scope. */
export function inRunScope<T>(runId: string, work: () => T): T {
  return scope.run(runId, work);
}

/**
 * Runs `work` outside any run's scope: for work that outlives the run that happened to start it,
 * like the Codex connection, whose messages belong to no run.
 */
export function outsideRunScope<T>(work: () => T): T {
  return scope.exit(work);
}

/** The run the current async work is for, if any. */
export function currentRunId(): string | undefined {
  return scope.getStore();
}
