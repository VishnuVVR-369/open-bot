import type { WorkerSignal } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import { signalHandlers, type Feature } from "./feature";

/** A feature that only answers `signals`, each by recording its name in `heard`. */
function answering<Signal extends WorkerSignal>(
  name: string,
  signals: readonly Signal[],
  heard: string[],
): Feature<Signal> {
  return {
    name,
    start: async () => {},
    signals: Object.fromEntries(
      signals.map((signal) => [signal, () => void heard.push(`${name} ${signal}`)]),
    ) as Record<Signal, () => void>,
  };
}

describe("signalHandlers", () => {
  it("routes each signal to the feature that answers it, and the rest to index.ts", () => {
    const heard: string[] = [];
    const handlers = signalHandlers(
      [answering("automations", ["schedules"], heard), answering("triggers", ["triggers"], heard)],
      {
        runs: () => void heard.push("index runs"),
        cancel: () => void heard.push("index cancel"),
        accounts: () => void heard.push("index accounts"),
      },
    );
    for (const signal of ["runs", "schedules", "triggers", "cancel", "accounts"] as const)
      handlers[signal]();
    expect(heard).toEqual([
      "index runs",
      "automations schedules",
      "triggers triggers",
      "index cancel",
      "index accounts",
    ]);
  });

  it("refuses a signal two features answer", () => {
    const heard: string[] = [];
    expect(() =>
      signalHandlers(
        [answering("one", ["triggers"], heard), answering("two", ["triggers"], heard)],
        { runs() {}, schedules() {}, cancel() {}, accounts() {} },
      ),
    ).toThrow("The triggers signal is answered by both the one feature and the two feature.");
  });

  it("refuses a signal nothing answers", () => {
    const own = { runs() {}, schedules() {}, triggers() {}, cancel() {} };
    expect(() => signalHandlers([], own as Record<WorkerSignal, () => void>)).toThrow(
      "Nothing answers the accounts signal.",
    );
  });

  it("doesn't compile when index.ts answers a feature's signal, or leaves one out", () => {
    const feature = answering("automations", ["schedules", "triggers"], []);
    const run = (build: () => unknown) => expect(build).toThrow();
    // A second handler for a signal the feature answers.
    run(() =>
      signalHandlers([feature], {
        runs() {},
        cancel() {},
        accounts() {},
        // @ts-expect-error the automations feature answers it
        triggers() {},
      }),
    );
    // @ts-expect-error accounts has no handler
    run(() => signalHandlers([feature], { runs() {}, cancel() {} }));
    // The same second handler in a variable, where excess properties aren't checked.
    const every = { runs() {}, schedules() {}, triggers() {}, cancel() {}, accounts() {} };
    // @ts-expect-error the automations feature answers schedules and triggers
    run(() => signalHandlers([feature], every));
  });
});
