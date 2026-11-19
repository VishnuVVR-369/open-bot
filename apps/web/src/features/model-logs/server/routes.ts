import "server-only";
import { os } from "@/lib/server/api/rpc";
import { getModelRequestBodies, getRunEvent, listRunEvents } from "./bodies";
import { getRunModelLogs } from "./run";
import { listModelLogRuns } from "./runs";

/**
 * Model logs, as Settings and the run inspector ask (`contract.modelLogs`). Read straight from the
 * tables the worker's model log writer owns; only the owner's session reaches them.
 */
export function modelLogRoutes() {
  return {
    runs: os.modelLogs.runs.handler(({ input }) => listModelLogRuns(input)),
    run: os.modelLogs.run.handler(({ input }) => getRunModelLogs(input.runId)),
    request: os.modelLogs.request.handler(({ input }) => getModelRequestBodies(input.requestId)),
    events: os.modelLogs.events.handler(({ input }) => listRunEvents(input.runId)),
    event: os.modelLogs.event.handler(({ input }) => getRunEvent(input.eventId)),
  };
}
