import type { Feature } from "../../core/feature";
import { ModelLogAnnouncer, type SavedLogs } from "./announcer";
import type { ModelLogRetention } from "./retention";
import type { ModelLogWriter } from "./writer";

/**
 * Model logs' background work: the writer, which saves queued requests in batches; the
 * announcer, which tells open tabs once they are saved (`announce`); and the daily retention
 * sweep, which expires old bodies. They start announcer, writer, sweep, so at shutdown the sweep
 * stops first, after its batch; then the writer writes what is still queued before the database
 * closes; and the announcer, still listening, announces that before it stops.
 */
export function modelLogsFeature(
  writer: Pick<ModelLogWriter, "start" | "stop"> & SavedLogs,
  announce: () => Promise<void>,
  retention: Pick<ModelLogRetention, "start" | "stop">,
): Feature {
  return {
    name: "model logs",
    async start(runtime) {
      await runtime.start("model log announcer", new ModelLogAnnouncer(writer, announce));
      await runtime.start("model log writer", writer);
      await runtime.start("model log retention", retention);
    },
    signals: {},
  };
}
