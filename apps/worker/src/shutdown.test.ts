import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountActions } from "./accounts/actions";
import type { Context } from "./context";
import type { Feature } from "./core/feature";
import { automationsFeature } from "./features/automations";
import { FcmService } from "./services/fcm";
import { PushService } from "./services/push";

/** A loop that does nothing: features here are only asked what they register. */
const loop = { start() {}, stop() {}, kick() {} };

/** The features index.ts starts, each with `<name>.start(runtime)`, by that name. */
const FEATURES: Record<string, Pick<Feature, "start">> = {
  automations: automationsFeature({ schedules: loop, triggers: loop, accountTriggers: loop }),
};

/** The names of the parts `feature` registers with the Runtime, in order, without starting any. */
async function partsOf(feature: Pick<Feature, "start">): Promise<string[]> {
  const names: string[] = [];
  const record = (name: string) => void names.push(name);
  await feature.start({
    add: record,
    start: async (name) => record(name),
    every: record,
    after: record,
  });
  return names;
}

const REGISTER = new Set(["start", "add", "every", "after"]);

/**
 * The order index.ts stops its parts in: the reverse of the order it registers them with the
 * Runtime, itself (`runtime.add("name", …)`) or through a feature it starts
 * (`<feature>.start(runtime)`). Any other call that is handed the runtime fails the test, since
 * what it registers can't be seen, and so does a feature in FEATURES that index.ts never starts.
 */
async function stopOrder(): Promise<string[]> {
  const file = path.join(import.meta.dirname, "index.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const steps: ({ part: string } | { feature: string })[] = [];
  const unknown: string[] = [];
  const isRuntime = (node: ts.Node) => ts.isIdentifier(node) && node.text === "runtime";
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (ts.isPropertyAccessExpression(callee) && isRuntime(callee.expression)) {
        if (REGISTER.has(callee.name.text)) {
          if (first && ts.isStringLiteralLike(first)) steps.push({ part: first.text });
          else unknown.push(node.getText(source));
        }
      } else if (node.arguments.some(isRuntime)) {
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "start" &&
          ts.isIdentifier(callee.expression) &&
          node.arguments.length === 1
        )
          steps.push({ feature: callee.expression.text });
        else unknown.push(node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(unknown, "calls handed the runtime that this test can't follow").toEqual([]);
  const started = steps.flatMap((step) => ("feature" in step ? [step.feature] : []));
  expect(started.toSorted(), "features index.ts starts").toEqual(Object.keys(FEATURES).toSorted());
  const names: string[] = [];
  for (const step of steps)
    names.push(...("part" in step ? [step.part] : await partsOf(FEATURES[step.feature]!)));
  expect(new Set(names).size).toBe(names.length);
  return names.reverse();
}

describe("shutdown order", async () => {
  const order = await stopOrder();
  const at = (name: string) => {
    expect(order).toContain(name);
    return order.indexOf(name);
  };

  // These pin the order of the stop calls, not that each part has finished all its work by then.
  it("drains account actions after the stop of everything that adds to them", () => {
    for (const producer of [
      "http server",
      "signal listener",
      "safety sweep",
      "computer lifecycle",
      "schedules",
      "triggers",
      "account triggers",
    ])
      expect(at(producer), producer).toBeLessThan(at("account actions"));
  });

  it("keeps notifications and what actions use running until account actions have drained", () => {
    for (const consumer of [
      "web push",
      "phone notifications",
      "telegram",
      "integrations",
      "codex",
      "database",
    ])
      expect(at(consumer), consumer).toBeGreaterThan(at("account actions"));
  });

  it("pauses the computer before stopping the connections it pauses, and closes the database last", () => {
    for (const part of ["egress relay", "codex", "computer"])
      expect(at("computer lifecycle"), part).toBeLessThan(at(part));
    expect(order.at(-1)).toBe("database");
  });
});

/** What shutdown relies on: once stopped, a service holds no timers and hears no events. */
describe("stopping services", () => {
  const events = new EventEmitter();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const listeners = () =>
    events.eventNames().reduce((sum, name) => sum + events.listenerCount(name), 0);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    events.removeAllListeners();
  });

  it("stops web push", () => {
    const push = new PushService({ events, log } as unknown as Context);
    push.start();
    expect(listeners()).toBeGreaterThan(0);
    push.stop();
    expect(listeners()).toBe(0);
  });

  it("stops phone notifications", () => {
    const account = { project_id: "p", client_email: "e@p.test", private_key: "k" };
    const env = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account) };
    const fcm = new FcmService({ events, log, env } as unknown as Context);
    fcm.start();
    expect(listeners()).toBeGreaterThan(0);
    fcm.stop();
    expect(listeners()).toBe(0);
  });

  it("stops account actions' sweeps", async () => {
    // The first query fails, so the first sweep logs and ends without touching anything.
    const db = {
      update() {
        throw new Error("no database");
      },
    };
    const actions = new AccountActions(
      ...([{ events, log, db }, null, null, null, null] as unknown as ConstructorParameters<
        typeof AccountActions
      >),
    );
    actions.start();
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(listeners()).toBeGreaterThan(0);
    actions.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners()).toBe(0);
  });

  it("starts no sweep or poll for work that finishes after stopping", async () => {
    // A sweep is in flight when shutdown starts and has been asked to run again; its first query
    // answers only after stop(), and every later query finds nothing, so the sweep completes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Each sweep starts by expiring old actions, so that query counts the sweeps.
    let sweeps = 0;
    // Drizzle's fluent builder: each step returns the query, which is awaited at the end.
    const query = (result: () => Promise<unknown>) => {
      const step = () => chain;
      const chain = {
        set: (values: { status?: string }) => {
          if (values.status === "expired" && sweeps++ === 0) result = () => held.then(() => []);
          return chain;
        },
        from: step,
        where: step,
        orderBy: step,
        limit: step,
        returning: step,
        then: (ok: (rows: unknown) => unknown, fail: (error: unknown) => unknown) =>
          result().then(ok, fail),
      };
      return chain;
    };
    const none = () => Promise.resolve([]);
    const update = vi.fn(() => query(none));
    const db = { update, select: () => query(none) };
    const actions = new AccountActions(
      ...([{ events, log, db }, null, null, null, null] as unknown as ConstructorParameters<
        typeof AccountActions
      >),
    );
    actions.start();
    actions.kick();
    actions.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweeps).toBe(1);
    const updates = update.mock.calls.length;
    actions.kick();
    (actions as unknown as { schedulePoll(id: string, ms: number): void }).schedulePoll("a1", 10);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweeps).toBe(1);
    expect(update).toHaveBeenCalledTimes(updates);
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
