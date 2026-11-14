import "server-only";
import { OFFLINE_EGRESS_STATUS, type EgressStatusView } from "@open-bot/api";
import type { WorkerStatus } from "@open-bot/api/worker";
import { worker } from "./worker";

/** The worker's status, or null when it doesn't answer quickly. */
export async function workerStatus(): Promise<WorkerStatus | null> {
  try {
    const status = await worker.status.get(undefined, { context: { timeoutMs: 2_500 } });
    return { ...status, egress: withEgressDefaults(status.egress) };
  } catch {
    return null;
  }
}

/**
 * A worker deployed before phones could carry traffic reports only the desktop's state; fill in
 * the rest so the web and a newer worker can roll out in either order.
 */
function withEgressDefaults(egress: Partial<EgressStatusView>): EgressStatusView {
  const merged = { ...OFFLINE_EGRESS_STATUS, ...egress };
  if (egress.path) return merged;
  const path =
    merged.mode !== "off" && merged.agentOnline
      ? "desktop"
      : merged.mode === "require"
        ? "blocked"
        : "direct";
  return { ...merged, path };
}
