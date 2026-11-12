import { describe, expect, it } from "vitest";
import { isWorkerSignal, WORKER_SIGNALS } from "./notify";

describe("isWorkerSignal", () => {
  it("accepts every signal the worker handles", () => {
    for (const signal of WORKER_SIGNALS) expect(isWorkerSignal(signal)).toBe(true);
  });

  it("ignores anything else on the channel", () => {
    for (const payload of ["", "RUNS", "run", "cancel ", "toString", '{"type":"runs"}'])
      expect(isWorkerSignal(payload)).toBe(false);
  });
});
