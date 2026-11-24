import { EventEmitter } from "node:events";
import type { TimelineItem } from "@open-bot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, WorkerEvents } from "../../context";
import type { NativePush } from "./fcm";
import { RunProgressService, type RunProgressSnapshot } from "./run-progress";
import type { RunProgressStore } from "./run-progress-store";

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
  /** When each request was made, in ms since the test began. */
  const startedAt: number[] = [];
  /** What happened, in order: pushes by state, and the store's writes. */
  const log: string[] = [];
  let configured = true;
  /** A send that hasn't been answered yet, when a test holds one back. */
  let hold: Promise<void> | null = null;
  /** How long FCM takes to answer each send, in ms. */
  let latency = 0;
  /** How many sends of an end fail before one works. */
  let endFailures = 0;
  /** How many saves that a run shows fail before one works. */
  let saveFailures = 0;
  /** A save that hasn't been answered yet, when a test holds one back. */
  let saveHold: Promise<void> | null = null;
  const fcm = {
    get configured() {
      return configured;
    },
    async deliver(push: NativePush) {
      sent.push(push);
      startedAt.push(Date.now() - new Date(at).getTime());
      log.push(`push:${push.data.runId}:${push.data.runState}`);
      if (hold) await hold;
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
      if (push.data.runState === "ended" && endFailures > 0) {
        endFailures -= 1;
        return { sent: 0, failed: 1 };
      }
      return { sent: 1, failed: 0 };
    },
  };
  /** Runs whose end is owed, as the database keeps them. */
  const owed = new Set<string>();
  /** Runs whose end is recorded: a save that lands later changes nothing. */
  const closed = new Set<string>();
  /** How many times `overdue()` was asked: the worker's start and each sweep. */
  let sweeps = 0;
  /** Runs that are over, for `overdue()`. */
  const over = new Set<string>();
  const store: RunProgressStore = {
    async shown(runId) {
      if (saveHold) await saveHold;
      if (saveFailures > 0) {
        saveFailures -= 1;
        log.push(`shown-failed:${runId}`);
        throw new Error("database unavailable");
      }
      if (closed.has(runId)) {
        log.push(`shown-refused:${runId}`);
        return false;
      }
      log.push(`shown:${runId}`);
      owed.add(runId);
      return true;
    },
    async owed(runId) {
      return owed.has(runId);
    },
    async ended(runId) {
      log.push(`ended:${runId}`);
      owed.delete(runId);
      closed.add(runId);
    },
    async overdue() {
      sweeps += 1;
      return [...owed].filter((runId) => over.has(runId));
    },
  };
  const snapshots = new Map<string, RunProgressSnapshot>();
  let service: RunProgressService;
  const warn = vi.fn();
  const create = () =>
    new RunProgressService(
      { events, log: { warn } } as unknown as Context,
      fcm,
      (runId) => snapshots.get(runId) ?? null,
      store,
    );

  const snapshot = (runId: string, patch: Partial<RunProgressSnapshot> = {}) => {
    const next: RunProgressSnapshot = {
      teammateId: "t1",
      teammateName: "Rex",
      chatId: "c1",
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
  /** The teammate's plan moves on: `done` of its `total` steps are done. */
  const planStep = (id: string, done: number, total = 30, label = "Book the flight") => {
    const plan: TimelineItem = {
      id: "plan",
      kind: "plan",
      status: "running",
      startedAt: at,
      steps: Array.from({ length: total }, (_, index) => ({
        step: `${label} ${index}`,
        status: index < done ? "completed" : index === done ? "inProgress" : "pending",
      })),
    };
    snapshot(id, { status: "running", items: [plan] });
    events.emit("runProgress", id, "step");
  };
  const finish = (id = "r1", trigger = "user") => {
    snapshots.delete(id);
    over.add(id);
    events.emit("runFinished", { id, trigger }, "completed", "Done");
  };
  const states = () => sent.map((push) => push.data.runState);

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(at) });
    configured = true;
    hold = null;
    latency = 0;
    endFailures = 0;
    saveFailures = 0;
    saveHold = null;
    sweeps = 0;
    sent.length = 0;
    startedAt.length = 0;
    log.length = 0;
    owed.clear();
    closed.clear();
    over.clear();
    snapshots.clear();
    service = create();
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
        title: "Rex is working",
        body: "Using a tool",
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
      planStep("r1", i);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // At 20s, then 35s and 50s: three messages for 30 steps.
    expect(sent.map((push) => push.data.stepsDone)).toEqual([undefined, "14", "29"]);
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
      title: "Rex is waiting for you",
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

  it("ends a shown run with one last message, without a collapse key, and sends nothing later", async () => {
    start();
    step("r1", "Opened example.com");
    await vi.advanceTimersByTimeAsync(20_000);
    // An update is still being sent when the end arrives.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    planStep("r1", 1);
    await vi.advanceTimersByTimeAsync(15_000);
    finish();
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

  it("ends runs a restart interrupted only when they showed, and only once", async () => {
    owed.add("old");
    events.emit("runFinished", { id: "old", trigger: "user" }, "interrupted", null, "Restarted");
    events.emit("runFinished", { id: "never-shown", trigger: "user" }, "interrupted", null);
    events.emit("runFinished", { id: "helper", trigger: "swarm" }, "interrupted", null);
    await service.idle();
    expect(sent.map((push) => [push.data.runId, push.data.runState])).toEqual([["old", "ended"]]);
    expect(owed.has("old")).toBe(false);
    events.emit("runFinished", { id: "old", trigger: "user" }, "interrupted", null);
    await service.idle();
    expect(sent).toHaveLength(1);
  });

  it("records that the end is owed before the first update, and forgets it once the end is sent", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).toEqual(["shown:r1", "push:r1:starting"]);
    finish();
    await service.idle();
    expect(log).toEqual(["shown:r1", "push:r1:starting", "push:r1:ended", "ended:r1"]);
  });

  it("tries a failed end again, and keeps it owed until a phone got it", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    endFailures = 2;
    finish();
    await service.idle();
    expect(owed.has("r1")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await service.idle();
    expect(owed.has("r1")).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await service.idle();
    expect(states()).toEqual(["starting", "ended", "ended", "ended"]);
    expect(owed.has("r1")).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(4);
  });

  it("sends, when it starts, the ends owed by runs that were over before it stopped", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    // The run's last status is stored, then the worker stops before `runFinished`.
    over.add("r1");
    service.stop();
    expect(states()).toEqual(["starting"]);
    // A run still going is left to recovery, which finishes it.
    owed.add("r2");
    service = create();
    service.start();
    await service.idle();
    expect(sent.map((push) => [push.data.runId, push.data.runState])).toEqual([
      ["r1", "starting"],
      ["r1", "ended"],
    ]);
    expect([...owed]).toEqual(["r2"]);
  });

  it("sends an end whose every try failed at the next sweep, without waiting for a restart", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    // The first send and its three retries (30 s, 2 min and 10 min later) all fail.
    endFailures = 4;
    finish();
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    await service.idle();
    expect(states()).toEqual(["starting", "ended", "ended", "ended", "ended"]);
    expect(owed.has("r1")).toBe(true);
    // The sweep, 15 minutes after the worker started, sends it again.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await service.idle();
    expect(states()).toHaveLength(6);
    expect(owed.has("r1")).toBe(false);
    expect(sweeps).toBe(2);
    // A stopped service sweeps no more.
    service.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sweeps).toBe(2);
  });

  it("leaves a run it tracks, or one waiting for a retry, to that and not to the sweep", async () => {
    start("live");
    start("retrying");
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 50_000);
    // Its end fails 10 s before the sweep, so its retry is due 20 s after it.
    endFailures = 1;
    finish("retrying");
    await service.idle();
    // The live run's last status is stored, but its `runFinished` hasn't come yet: the database
    // says both are over and owe their end.
    over.add("live");
    await vi.advanceTimersByTimeAsync(10_000);
    await service.idle();
    expect(sweeps).toBe(2);
    const ends = () => sent.filter((push) => push.data.runState === "ended");
    expect(ends().map((push) => push.data.runId)).toEqual(["retrying"]);
    await vi.advanceTimersByTimeAsync(20_000);
    await service.idle();
    expect(ends().map((push) => push.data.runId)).toEqual(["retrying", "retrying"]);
    expect(owed.has("retrying")).toBe(false);
  });

  it("keeps only the newest update waiting behind a slow send, so a status change goes next", async () => {
    latency = 20_000;
    start();
    // The first update goes at 20s, and FCM answers it at 40s.
    await vi.advanceTimersByTimeAsync(21_000);
    // A new step's update is asked for at 35s, the wait's at 37s: both while the first is sent.
    planStep("r1", 1);
    await vi.advanceTimersByTimeAsync(15_000);
    snapshot("r1", { status: "waiting", waitingFor: "approval" });
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(30_000);
    // The wait replaced the step, and went as soon as the first send was answered.
    expect(states()).toEqual(["starting", "waiting"]);
    expect(startedAt).toEqual([20_000, 40_000]);
  });

  it("builds the update waiting behind a slow send when it goes, so a wait never follows an old step", async () => {
    latency = 16_500;
    start();
    // The first update goes at 20s, and FCM answers it at 36.5s.
    await vi.advanceTimersByTimeAsync(21_000);
    // A step's update is due at 35s, while the first is being sent; the run waits at 36s.
    planStep("r1", 1);
    await vi.advanceTimersByTimeAsync(15_000);
    snapshot("r1", { status: "waiting", waitingFor: "approval" });
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(30_000);
    // The wait went as soon as the first send was answered, and the step it replaced never did.
    expect(states()).toEqual(["starting", "waiting"]);
    expect(startedAt).toEqual([20_000, 36_500]);
    expect(sent[1]!.data).toMatchObject({ body: "Waiting for your approval", stepsDone: "1" });
  });

  it("sends no update until its end is saved as owed, and tries the save again later", async () => {
    saveFailures = 2;
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual([]);
    // The run's next change tries again, 2 seconds after the last try for a status.
    await vi.advanceTimersByTimeAsync(1_000);
    snapshot("r1", { status: "running" });
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual(["shown-failed:r1", "shown-failed:r1"]);
    // Then a timer does, while nothing happens: 15 seconds later.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual(["shown-failed:r1", "shown-failed:r1", "shown:r1", "push:r1:working"]);
    expect(startedAt).toEqual([37_000]);
    finish();
    await service.idle();
    expect(states()).toEqual(["working", "ended"]);
    expect(owed.has("r1")).toBe(false);
  });

  it("sends nothing while the save is held, and no end for a run that finishes before any update went", async () => {
    let release!: () => void;
    saveHold = new Promise((resolve) => (release = resolve));
    start("refused");
    start("late");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
    // Both runs end while their first saves are held: no phone shows them, so their ends are
    // recorded without a push, and the save that lands later can't make one owed.
    finish("refused");
    finish("late");
    saveFailures = 1;
    release();
    await service.idle();
    expect(log).toEqual([
      "ended:refused",
      "ended:late",
      "shown-failed:refused",
      "shown-refused:late",
    ]);
    expect(sent).toEqual([]);
    expect(owed.size).toBe(0);
  });

  it("sends the end at once while a keepalive's save is held, and the save landing later sends nothing", async () => {
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    let release!: () => void;
    saveHold = new Promise((resolve) => (release = resolve));
    // The keepalive's save hangs; the run ends meanwhile.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(states()).toEqual(["starting", "ended"]);
    expect(log).toEqual(["shown:r1", "push:r1:starting", "push:r1:ended", "ended:r1"]);
    release();
    await service.idle();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(log.at(-1)).toBe("shown-refused:r1");
    expect(states()).toEqual(["starting", "ended"]);
    expect(owed.has("r1")).toBe(false);
  });

  it("builds an update once its save is done, so a wait during the save goes as the wait", async () => {
    let release!: () => void;
    saveHold = new Promise((resolve) => (release = resolve));
    start();
    snapshot("r1", { status: "running" });
    await vi.advanceTimersByTimeAsync(20_000);
    // The save for the run's first update is going when the run starts waiting on you.
    snapshot("r1", { status: "waiting", waitingFor: "approval" });
    events.emit("runProgress", "r1", "status");
    await vi.advanceTimersByTimeAsync(5_000);
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.map((push) => push.data.body)).toEqual(["Waiting for your approval"]);
    expect(states()).toEqual(["waiting"]);
  });

  it("drops an update still waiting when the run ends", async () => {
    latency = 20_000;
    start();
    await vi.advanceTimersByTimeAsync(21_000);
    step("r1", "Opened example.org");
    await vi.advanceTimersByTimeAsync(15_000);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    await service.idle();
    expect(states()).toEqual(["starting", "ended"]);
  });

  it("never puts a command, a path, a URL, a query or a plan step in a push", async () => {
    const secret = "dummy123";
    start();
    snapshot("r1", {
      status: "running",
      items: [
        {
          id: "p1",
          kind: "plan",
          status: "running",
          startedAt: at,
          steps: [
            { step: `Export API_TOKEN=${secret}`, status: "completed" },
            { step: `Run API_TOKEN=${secret} sleep 25`, status: "inProgress" },
          ],
        },
        tool("t1", `Read https://example.com/?token=${secret}`),
        {
          id: "w1",
          kind: "web_search",
          query: `password ${secret}`,
          status: "completed",
          startedAt: at,
        },
        {
          id: "f1",
          kind: "file_change",
          changes: [{ path: `/home/bot/${secret}.env`, change: "add", diff: secret }],
          status: "completed",
          startedAt: at,
        },
        {
          id: "c1",
          kind: "command",
          command: `/bin/bash -lc 'API_TOKEN=${secret} sleep 25'`,
          cwd: "/home/bot",
          output: secret,
          exitCode: null,
          durationMs: null,
          status: "running",
          startedAt: at,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    // Every field: ids, times, the fixed words, the plan's counts.
    expect(sent[0]!.data).toEqual({
      type: "run-progress",
      tag: "run-progress:r1",
      runId: "r1",
      runState: "working",
      sentAt: "2026-11-22T10:00:20.000Z",
      chatId: "c1",
      teammateId: "t1",
      url: "/chats/c1?run=r1",
      startedAt: at,
      title: "Rex is working",
      body: "Running a command",
      stepsDone: "1",
      stepsTotal: "2",
    });
    for (const item of snapshots.get("r1")!.items.slice(1, -1)) {
      snapshot("r1", { items: [...snapshots.get("r1")!.items.filter((i) => i !== item), item] });
      events.emit("runProgress", "r1", "step");
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(sent.map((push) => push.data.body)).toEqual([
      "Running a command",
      "Using a tool",
      "Searching the web",
      "Editing a file",
    ]);
    expect(JSON.stringify(sent)).not.toContain(secret);
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
