import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { services, worker, teammateWithRun } = h;

  it("messages and runs: dispatches, retries once however often asked, and cancels", async () => {
    await worker.messages.dispatch({ messageId: ID });
    expect(services.executor.dispatchMessage).toHaveBeenLastCalledWith(ID);
    const { run } = await teammateWithRun();
    const [first, again] = await Promise.all([
      worker.runs.retry({ runId: run.id }),
      worker.runs.retry({ runId: run.id }),
    ]);
    expect(first.runId).not.toBe(run.id);
    expect(again).toEqual(first);
    expect(await failure(worker.runs.retry({ runId: first.runId }))).toEqual({
      status: 409,
      message: "That run is still going.",
    });
    await worker.runs.processCancellations();
    expect(services.executor.processCancellations).toHaveBeenCalled();
  });
});
