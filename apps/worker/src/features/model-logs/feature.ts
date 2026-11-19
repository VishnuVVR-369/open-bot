import type { Feature } from "../../core/feature";
import { ModelLogAnnouncer, type SavedLogs } from "./announcer";
import type { ModelLogWriter } from "./writer";

/**
 * Model logs' background work: the writer, which saves queued requests in batches, and the
 * announcer, which tells open tabs once they are saved (`announce`). The announcer starts first,
 * so at shutdown the writer stops first: it writes what is still queued before the database
 * closes, and the announcer, still listening, announces that before it stops.
 */
export function modelLogsFeature(
  writer: Pick<ModelLogWriter, "start" | "stop"> & SavedLogs,
  announce: () => Promise<void>,
): Feature {
  return {
    name: "model logs",
    async start(runtime) {
      await runtime.start("model log announcer", new ModelLogAnnouncer(writer, announce));
      await runtime.start("model log writer", writer);
    },
    signals: {},
  };
}
