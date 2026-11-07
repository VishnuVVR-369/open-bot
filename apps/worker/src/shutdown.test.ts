import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountActions } from "./accounts/actions";
import { NotionTools } from "./accounts/notion";
import { Integrations } from "./accounts/registry";
import type { Context } from "./context";
import { FcmService } from "./services/fcm";
import { PushService } from "./services/push";

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

  it("stops Notion's idle sweep through the integrations", async () => {
    const integrations = new Integrations([new NotionTools({ events, log } as unknown as Context)]);
    expect(vi.getTimerCount()).toBe(1);
    await integrations.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
