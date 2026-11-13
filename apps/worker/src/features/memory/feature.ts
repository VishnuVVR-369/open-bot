import type { Feature } from "../../core/feature";
import type { Startable } from "../../core/runtime";

/** Memory's background work: the jobs that embed new memories and extract them from chats. */
export function memoryFeature(memory: Startable): Feature {
  return {
    name: "memory",
    async start(runtime) {
      await runtime.start("memory", memory);
    },
    signals: {},
  };
}
