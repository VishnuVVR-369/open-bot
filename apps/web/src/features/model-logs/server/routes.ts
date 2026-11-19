import "server-only";
import { os } from "@/lib/server/api/rpc";
import { getModelRequestBodies, getRunEvent, listRunEvents } from "./bodies";
import { getRunModelLogs } from "./run";
import { listFilterOptions } from "./filters";
import { getRetention, setRetention } from "./retention";
import { listModelLogRuns } from "./runs";
import { listToolFailures, listToolStats } from "./tool-stats";
import { getModelLogUsage } from "./usage";

/**
 * Model logs, as Settings and the run inspector ask (`contract.modelLogs`). Read straight from the
 * tables the worker's model log writer owns; only the owner's session reaches them.
 */
export function modelLogRoutes() {
  return {
    runs: os.modelLogs.runs.handler(({ input }) => listModelLogRuns(input)),
    filters: os.modelLogs.filters.handler(() => listFilterOptions()),
    tools: os.modelLogs.tools.handler(({ input }) => listToolStats(input)),
    toolFailures: os.modelLogs.toolFailures.handler(({ input }) => listToolFailures(input)),
    usage: os.modelLogs.usage.handler(({ input }) => getModelLogUsage(input)),
    retention: os.modelLogs.retention.handler(() => getRetention()),
    setRetention: os.modelLogs.setRetention.handler(({ input }) => setRetention(input)),
    run: os.modelLogs.run.handler(({ input }) => getRunModelLogs(input.runId)),
    request: os.modelLogs.request.handler(({ input }) => getModelRequestBodies(input.requestId)),
    events: os.modelLogs.events.handler(({ input }) => listRunEvents(input.runId)),
    event: os.modelLogs.event.handler(({ input }) => getRunEvent(input.eventId)),
  };
}
