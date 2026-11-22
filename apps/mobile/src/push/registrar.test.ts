import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushRegistrar, REGISTER_RETRY_MS } from "./registrar";

describe("PushRegistrar", () => {
  /** What the server answers each registration with, in order; past the end, it stores it. */
  let answers: (string | undefined | Error)[] = [];
  let token = "token-1";
  const requests: string[] = [];
  let registrar: PushRegistrar;

  const create = () =>
    new PushRegistrar({
      registration: "reg-1",
      token: async () => token,
      register: async (sent, registration) => {
        requests.push(`${sent} ${registration}`);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answers.length || answer !== undefined ? answer : registration;
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    answers = [];
    token = "token-1";
    requests.length = 0;
    registrar = create();
  });
  afterEach(() => {
    registrar.stop();
    vi.useRealTimers();
  });

  it("registers once, and again only for a new token", async () => {
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(registrar.confirmed).toBe(true);
    // Back on screen, back online: the server has this token already.
    registrar.sync();
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["token-1 reg-1"]);
    // The token changed while the app wasn't running: the next resume registers it.
    token = "token-2";
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["token-1 reg-1", "token-2 reg-1"]);
  });

  it("tries a failed registration again with backoff, then on the next sync", async () => {
    answers = [new Error("503"), new Error("503"), new Error("503"), new Error("503")];
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[0]);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[1]);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[2]);
    expect(requests).toHaveLength(4);
    expect(registrar.confirmed).toBe(false);
    // Out of tries: nothing more until something changes.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(requests).toHaveLength(4);
    // You open the app again, and the server is back.
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(5);
    expect(registrar.confirmed).toBe(true);
  });

  it("counts a registration the server didn't store as failed, so a mixed rollout can't drop it", async () => {
    // A web app or worker older than this app answers without it, or another one is stored.
    answers = [undefined, "reg-0"];
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(registrar.confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[0]);
    expect(registrar.confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[1]);
    expect(requests).toEqual(["token-1 reg-1", "token-1 reg-1", "token-1 reg-1"]);
    expect(registrar.confirmed).toBe(true);
  });

  it("sends nothing once stopped, and ignores a reply that comes after", async () => {
    let release!: (value: string) => void;
    const held = new PushRegistrar({
      registration: "reg-1",
      token: async () => token,
      register: (sent) => {
        requests.push(sent);
        return new Promise((resolve) => (release = resolve));
      },
    });
    held.sync();
    await vi.advanceTimersByTimeAsync(0);
    // You sign out while it's being sent.
    held.stop();
    release("reg-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(held.confirmed).toBe(false);
    held.sync();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(requests).toEqual(["token-1"]);
    // A retry that was waiting is cancelled too.
    answers = [new Error("offline")];
    registrar.sync();
    await vi.advanceTimersByTimeAsync(0);
    registrar.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(requests).toEqual(["token-1", "token-1 reg-1"]);
  });

  it("checks again after a sync that came while a registration was going", async () => {
    let release!: (value: string) => void;
    let calls = 0;
    const slow = new PushRegistrar({
      registration: "reg-1",
      token: async () => token,
      register: (sent, registration) => {
        calls += 1;
        requests.push(sent);
        if (calls > 1) return Promise.resolve(registration);
        return new Promise((resolve) => (release = resolve));
      },
    });
    slow.sync();
    await vi.advanceTimersByTimeAsync(0);
    // A new token arrives while the old one is being registered.
    token = "token-2";
    slow.sync();
    release("reg-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["token-1", "token-2"]);
    expect(slow.confirmed).toBe(true);
    slow.stop();
  });
});
