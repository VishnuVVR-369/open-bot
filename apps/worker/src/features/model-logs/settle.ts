// A finished run's usage is read from its model logs (the reply's footer, Settings and the cap),
// and its last requests are still being read and saved as its turn ends: the writer saves in
// batches about once a second. So before a run announces it is done, it waits for them, briefly.
import { errorMessage, type Logger } from "../../logger";
import type { ModelProxy } from "./proxy";
import type { ModelLogWriter } from "./writer";

/** The most a finishing run waits for its logs; past it, they're read once they land. */
export const SETTLE_MS = 3_000;

/**
 * Waits until the requests of these threads have been logged and everything queued by then is
 * saved, for at most `budgetMs`. Never throws: logging never holds up a run for long, and a run
 * never fails over it.
 */
export function modelLogSettler(
  proxy: Pick<ModelProxy, "settled">,
  writer: Pick<ModelLogWriter, "settle">,
  log: Pick<Logger, "warn">,
  budgetMs = SETTLE_MS,
): (threadIds: readonly string[]) => Promise<void> {
  return async (threadIds) => {
    const deadline = Date.now() + budgetMs;
    try {
      await proxy.settled(threadIds, budgetMs);
      await writer.settle(Math.max(0, deadline - Date.now()));
    } catch (error) {
      log.warn("couldn't wait for a run's model logs", { error: errorMessage(error) });
    }
  };
}
