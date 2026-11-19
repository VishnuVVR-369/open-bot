import type { Feature } from "../../core/feature";
import type { ModelLogWriter } from "./writer";

/**
 * Model logs' background work: the writer, which saves queued requests in batches. It stops
 * before the database closes, writing what is still queued.
 */
export function modelLogsFeature(writer: Pick<ModelLogWriter, "start" | "stop">): Feature {
  return {
    name: "model logs",
    async start(runtime) {
      await runtime.start("model log writer", writer);
    },
    signals: {},
  };
}
