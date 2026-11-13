import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../../core/runtime";
import { automationsFeature } from "./feature";

describe("automations feature", () => {
  const calls: string[] = [];
  const loop = (name: string) => ({
    start: () => void calls.push(`start ${name}`),
    stop: () => void calls.push(`stop ${name}`),
    kick: () => void calls.push(`kick ${name}`),
  });
  const feature = automationsFeature({
    schedules: loop("schedules"),
    triggers: loop("triggers"),
    accountTriggers: loop("account triggers"),
  });

  it("starts its loops in order and stops them in reverse at shutdown", async () => {
    calls.length = 0;
    const runtime = new Runtime({ warn: vi.fn() });
    await feature.start(runtime);
    expect(calls).toEqual(["start schedules", "start triggers", "start account triggers"]);
    calls.length = 0;
    await runtime.stop();
    expect(calls).toEqual(["stop account triggers", "stop triggers", "stop schedules"]);
  });

  it("wakes the scheduler, and every kind of trigger, on the web app's signals", () => {
    calls.length = 0;
    feature.signals.schedules();
    expect(calls).toEqual(["kick schedules"]);
    calls.length = 0;
    feature.signals.triggers();
    expect(calls).toEqual(["kick triggers", "kick account triggers"]);
  });
});
