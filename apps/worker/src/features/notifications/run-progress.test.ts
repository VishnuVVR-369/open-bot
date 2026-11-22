import { EventEmitter } from "node:events";
import type { TimelineItem } from "@open-bot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, WorkerEvents } from "../../context";
import type { NativePush } from "./fcm";
import { RunProgressService, type RunProgressSnapshot } from "./run-progress";

const at = "2026-11-22T10:00:00.000Z";
const tool = (id: string, label: string): TimelineItem => ({
  id,
  kind: "tool",
  name: "browse",
  label,
  args: {},
  status: "running",
  startedAt: at,
});

describe("RunProgressService", () => {
  const events = new EventEmitter<WorkerEvents>();
  const sent: NativePush[] = [];
  let configured = true;
  /** A send that hasn't been answered yet, when a test holds one back. */
  let hold: Promise<void> | null = null;
  const fcm = {
    get configured() {
      return configured;
    },
    async sendAll(push: NativePush) {
      sent.push(push);
      if (hold) await hold;
      return 1;
    },
  };
  const snapshots = new Map<string, RunProgressSnapshot>();
  let service: RunProgressService;
  const warn = vi.fn();

  const snapshot = (runId: string, patch: Partial<RunProgressSnapshot> = {}) => {
    const next: RunProgressSnapshot = {
      teammateId: "t1",
      teammateName: "Rex",
      chatId: "c1",
      chatTitle: "Lisbon trip",
      status: "running",
      waitingFor: null,
      items: [],
      ...snapshots.get(runId),
      ...patch,
    };
    snapshots.set(runId, next);
  };
  const start = (id = "r1", trigger = "user") => {
    snapshot(id, { status: "starting" });
    events.emit("runStarted", { id, trigger });
  };
  const step = (id: string, label: string) => {
    const items = [...(snapshots.get(id)?.items ?? []), tool(`i${label}`, label)];
    snapshot(id, { status: "running", items });
    events.emit("runProgress", id, "step");
  };
  const finish = (id = "r1", trigger = "user") => {
    snapshots.delete(id);
    events.emit("runFinished", { id, trigger }, "completed", "Done");
  };
  const states = () => sent.map((push) => push.data.runState);

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(at) });
    configured = true;
    hold = null;
    sent.length = 0;
    snapshots.clear();
    service = new RunProgressService(
      { events, log: { warn } } as unknown as Context,
      fcm,
      (runId) => snapshots.get(runId) ?? null,
    );
    service.start();
  });
  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it("sends nothing for a run that ends within 20 seconds", async () => {
    start();
    step("r1", "Opened example.com");
    await vi.advanceTimersByTimeAsync(19_000);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    await service.idle();
    expect(sent).toEqual([]);
  });

  it("shows a run after 20 seconds as a normal-priority message collapsed per run", async () => {
    start();
    step("r1", "Opened example.com");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      data: {
        type: "run-progress",
        tag: "run-progress:r1",
        runId: "r1",
        runState: "working",
        sentAt: "2026-11-22T10:00:20.000Z",
        chatId: "c1",
        teammateId: "t1",
        url: "/chats/c1?run=r1",
        startedAt: at,
        title: "Rex: Lisbon trip",
        body: "Opened example.com",
      },
      priority: "normal",
      collapseKey: "run-progress-r1",
      ttlSeconds: 600,
    });
  });

  it("sends new steps at most every 15 seconds, coalesced to the latest", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    for (let i = 0; i < 30; i++) {
      step("r1", `Step ${i}`);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // At 20s, then 35s and 50s: three messages for 30 steps.
    expect(sent.map((push) => push.data.body)).toEqual(["Getting ready", "Step 14", "Step 29"]);
    expect(sent.map((push) => push.data.sentAt)).toEqual([
      "2026-11-22T10:00:20.000Z",
      "2026-11-22T10:00:35.000Z",
      "2026-11-22T10:00:50.000Z",
    ]);
  });

  it("sends a status change within 2 seconds, and only once for the same state", async () => {
    start();
    step("r1", "Opened example.com");
    await vi.advanceTimersByTimeAsync(21_000);
    snapshot("r1", { status: "waiting", waitingFor: "approval" });
    events.emit("runProgress", "r1", "status");
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.at(-1)?.data).toMatchObject({
      runState: "waiting",
      title: "Rex: Lisbon trip",
      body: "Waiting for your approval",
    });
    expect(sent).toHaveLength(2);
    // Nothing changed: nothing is sent, until the keep-alive.
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.data.body).toBe("Waiting for your approval");
  });

  it("ends a shown run with one last message, after every update, and sends nothing later", async () => {
    start();
    step("r1", "Opened example.com");
    await vi.advanceTimersByTimeAsync(20_000);
    // The first update is still being sent when a step and the end arrive.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    step("r1", "Opened example.org");
    await vi.advanceTimersByTimeAsync(15_000);
    finish();
    expect(states()).toEqual(["working", "working"]);
    release();
    await service.idle();
    expect(states()).toEqual(["working", "working", "ended"]);
    expect(sent[2]).toEqual({
      data: {
        type: "run-progress",
        tag: "run-progress:r1",
        runId: "r1",
        runState: "ended",
        sentAt: "2026-11-22T10:00:35.001Z",
      },
      priority: "normal",
      collapseKey: "run-progress-r1",
      ttlSeconds: 86_400,
    });
    // A late event for the run changes nothing.
    events.emit("runProgress", "r1", "step");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(states()).toEqual(["working", "working", "ended"]);
  });

  it("keeps each run's messages in order, even if the clock steps back", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(new Date("2026-11-22T09:00:00.000Z"));
    finish();
    await service.idle();
    expect(sent.map((push) => push.data.sentAt)).toEqual([
      "2026-11-22T10:00:20.000Z",
      "2026-11-22T10:00:20.001Z",
    ]);
  });

  it("tracks runs apart, and leaves swarm helpers to their teammate's run", async () => {
    start("r1");
    start("h1", "swarm");
    await vi.advanceTimersByTimeAsync(10_000);
    start("r2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((push) => push.data.runId)).toEqual(["r1"]);
    finish("r1");
    finish("h1", "swarm");
    await vi.advanceTimersByTimeAsync(10_000);
    await service.idle();
    expect(sent.map((push) => [push.data.runId, push.data.runState])).toEqual([
      ["r1", "starting"],
      ["r1", "ended"],
      ["r2", "starting"],
    ]);
  });

  it("ends runs a restart interrupted, which it never saw start", async () => {
    events.emit("runFinished", { id: "old", trigger: "user" }, "interrupted", null, "Restarted");
    events.emit("runFinished", { id: "helper", trigger: "swarm" }, "interrupted", null);
    await service.idle();
    expect(sent.map((push) => [push.data.runId, push.data.runState])).toEqual([["old", "ended"]]);
  });

  it("does nothing without FCM", async () => {
    service.stop();
    configured = false;
    service.start();
    start();
    await vi.advanceTimersByTimeAsync(60_000);
    finish();
    await service.idle();
    expect(sent).toEqual([]);
  });
});
