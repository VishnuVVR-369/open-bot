import type { EgressMode, PhoneMode } from "@open-bot/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { PairedPhone } from "./relay";
import { WAKE_TIMINGS, WakeController, type WakeRelay } from "./wake";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

class FakeRelay implements WakeRelay {
  currentMode: EgressMode = "prefer";
  currentPhoneMode: PhoneMode = "fallback";
  activeKind: "desktop" | "phone" | null = null;
  activePhone: { id: string; since: number } | null = null;
  connectedPhones: string[] = [];
  connectedAt = new Map<string, number>();
  pairedPhones: PairedPhone[] = [];
  configChanges = 0;
  released: string[] = [];
  configChanged() {
    this.configChanges += 1;
  }
  releasePhone(id: string) {
    this.released.push(id);
  }
  pair(id: string, pushToken: string | null = `token-${id.slice(-1)}`) {
    this.pairedPhones.push({ id, name: id, generation: 1, pushToken, lastUsedAt: null });
  }
  phoneConnectedAt(id: string) {
    return this.connectedPhones.includes(id) ? (this.connectedAt.get(id) ?? null) : null;
  }
  connectPhone(id: string, now: number) {
    if (!this.connectedPhones.includes(id)) this.connectedPhones.push(id);
    this.connectedAt.set(id, now);
    this.activeKind = "phone";
    this.activePhone = { id, since: now };
  }
}

let now: number;
let relay: FakeRelay;
let leased: string[];
let pushConfigured: boolean;
let pushes: { phone: string; stage: "wake" | "ask"; mode: string; at: number }[];
let notices: number[];
let wake: WakeController;

function create() {
  wake = new WakeController({
    now: () => now,
    relay,
    leasedScreens: () => leased,
    pushConfigured: () => pushConfigured,
    push: async (phone, stage, mode) => {
      pushes.push({ phone: phone.id, stage, mode, at: now });
      return "sent";
    },
    phonesChanged: () => {},
    notifyUnanswered: async () => {
      notices.push(now);
    },
    publish: () => {},
    log: { warn: () => {} },
  });
}

/** Move the clock, evaluating every second as the worker does. */
function advance(ms: number) {
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + SECOND);
    wake.evaluate();
  }
}

const stages = () =>
  pushes.map((push) => `${push.phone.slice(-1)}:${push.stage}@${(push.at - start) / SECOND}`);
let start: number;

beforeEach(() => {
  now = 1_000_000_000_000;
  start = now;
  relay = new FakeRelay();
  relay.pair(A);
  leased = [];
  pushConfigured = true;
  pushes = [];
  notices = [];
  create();
});

/** Past the start grace, so wakes may go out. */
function pastGrace() {
  advance(WAKE_TIMINGS.startGraceMs);
  start = now;
}

describe("wake controller", () => {
  it("in fallback, wakes on demand, again at 30 s, then asks at 60 s and tells you elsewhere", async () => {
    pastGrace();
    wake.demand();
    advance(2 * MINUTE);
    expect(stages()).toEqual(["a:wake@0", "a:wake@30", "a:ask@60"]);
    expect(notices).toHaveLength(1);
    expect(wake.phoneStatus(A).unanswered).toBe(new Date(start).toISOString());
  });

  it("counts a leased screen as demand", () => {
    pastGrace();
    leased = ["teammate-1"];
    advance(SECOND);
    expect(stages()).toEqual(["a:wake@1"]);
  });

  it("holds botd while waking, and says a phone could be woken", () => {
    pastGrace();
    expect(wake.configExtras()).toEqual({ wakeable: true });
    wake.demand();
    expect(wake.configExtras()).toEqual({ wakeable: true, holdMs: WAKE_TIMINGS.askMs });
    expect(wake.waiting()).toBe(true);
    advance(WAKE_TIMINGS.askMs);
    expect(wake.configExtras()).toEqual({ wakeable: true });
    expect(wake.waiting()).toBe(false);
  });

  it("sends no wakes in the first minute after starting, but lets botd hold", () => {
    wake.demand();
    advance(30 * SECOND);
    expect(pushes).toEqual([]);
    expect(wake.configExtras().wakeable).toBe(true);
    advance(31 * SECOND);
    expect(pushes.map((push) => push.stage)).toEqual(["wake"]);
  });

  it("stops as soon as a phone connects, and clears its unanswered mark", () => {
    pastGrace();
    wake.demand();
    advance(2 * MINUTE);
    expect(wake.phoneStatus(A).unanswered).not.toBeNull();
    relay.connectPhone(A, now);
    advance(MINUTE);
    expect(wake.phoneStatus(A).unanswered).toBeNull();
    expect(pushes).toHaveLength(3);
  });

  it("starts a new episode 15 minutes after an unanswered one while demand stays", () => {
    pastGrace();
    leased = ["teammate-1"];
    advance(WAKE_TIMINGS.episodeMs + SECOND);
    expect(stages()).toEqual(["a:wake@1", "a:wake@31", "a:ask@61", "a:wake@901"]);
    // The notice through other channels stays at most hourly.
    advance(2 * MINUTE);
    expect(notices).toHaveLength(1);
  });

  it("doesn't wake while your Mac carries the traffic", () => {
    pastGrace();
    relay.activeKind = "desktop";
    wake.demand();
    advance(2 * MINUTE);
    expect(pushes).toEqual([]);
  });

  it("ends the episode when demand ends", () => {
    pastGrace();
    wake.demand();
    advance(10 * SECOND);
    expect(wake.waiting()).toBe(true);
    advance(WAKE_TIMINGS.demandMs);
    expect(wake.waiting()).toBe(false);
    expect(pushes).toHaveLength(3);
  });

  it("keeps waking the other phone when one says it can't help", () => {
    relay.pair(B);
    pastGrace();
    wake.unavailable(A, "low-battery");
    wake.demand();
    advance(2 * MINUTE);
    expect(stages()).toEqual(["b:wake@0", "b:wake@30", "b:ask@60"]);
    expect(pushes.every((push) => push.mode === "fallback")).toBe(true);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({
      reason: "low-battery",
      message: "Phone battery is low",
    });
    expect(wake.phoneStatus(A).waking).toBeNull();
  });

  it("asks a suppressed phone again once its 15 minutes are over", () => {
    pastGrace();
    wake.unavailable(A, "wifi-only");
    leased = ["teammate-1"];
    advance(WAKE_TIMINGS.suppressMs - 2 * SECOND);
    expect(pushes).toEqual([]);
    expect(wake.configExtras().wakeable).toBe(false);
    advance(3 * SECOND);
    expect(pushes.map((push) => push.stage)).toEqual(["wake"]);
  });

  it("never wakes without a push token, push configured, or a pairing", () => {
    relay.pairedPhones = [];
    relay.pair(A, null);
    pastGrace();
    wake.demand();
    advance(2 * MINUTE);
    expect(pushes).toEqual([]);
    expect(wake.configExtras()).toEqual({ wakeable: false });

    relay.pairedPhones = [];
    relay.pair(A);
    pushConfigured = false;
    wake.demand();
    advance(2 * MINUTE);
    expect(pushes).toEqual([]);

    relay.pairedPhones = [];
    pushConfigured = true;
    wake.demand();
    advance(2 * MINUTE);
    expect(pushes).toEqual([]);
  });

  it("in always, wakes with backoff without demand, and never asks", () => {
    relay.currentPhoneMode = "always";
    pastGrace();
    advance(45 * MINUTE);
    expect(pushes.every((push) => push.stage === "wake" && push.mode === "always")).toBe(true);
    // The first as soon as the start grace ends, then 30 s, 2 min, 10 min, 30 min apart.
    expect(pushes.map((push) => (push.at - start) / SECOND)).toEqual([0, 30, 150, 750, 2550]);
    expect(notices).toEqual([]);
  });

  it("in always, asks once a minute has passed with a screen waiting", () => {
    relay.currentPhoneMode = "always";
    pastGrace();
    leased = ["teammate-1"];
    advance(2 * MINUTE);
    expect(stages()).toEqual(["a:wake@0", "a:wake@30", "a:ask@60"]);
    expect(notices).toHaveLength(1);
  });

  it("in always, stops waking once the phone is connected, even while the Mac is too", () => {
    relay.currentPhoneMode = "always";
    pastGrace();
    advance(SECOND);
    relay.connectPhone(A, now);
    advance(10 * MINUTE);
    expect(pushes).toHaveLength(1);
  });

  it("in fallback, lets a phone go after 10 minutes without demand, but not in always", () => {
    pastGrace();
    wake.demand();
    advance(SECOND);
    relay.connectPhone(A, now);
    advance(WAKE_TIMINGS.releaseIdleMs - 2 * SECOND);
    expect(relay.released).toEqual([]);
    advance(2 * SECOND);
    expect(relay.released).toEqual([A]);

    relay.released = [];
    relay.currentPhoneMode = "always";
    advance(30 * MINUTE);
    expect(relay.released).toEqual([]);
  });

  it("does nothing while the phone mode or egress is off", () => {
    relay.currentPhoneMode = "off";
    pastGrace();
    wake.demand();
    advance(2 * MINUTE);
    relay.currentPhoneMode = "fallback";
    relay.currentMode = "off";
    wake.demand();
    advance(2 * MINUTE);
    expect(pushes).toEqual([]);
    expect(wake.configExtras()).toEqual({ wakeable: false });
  });

  it("stops an episode when the phone mode changes, and starts the other policy", () => {
    pastGrace();
    wake.demand();
    advance(10 * SECOND);
    relay.currentPhoneMode = "always";
    advance(SECOND);
    // The always policy starts over with its own first wake; the fallback retry never comes.
    expect(stages()).toEqual(["a:wake@0", "a:wake@11"]);
  });

  it("tells the relay when its config fields change", () => {
    pastGrace();
    const before = relay.configChanges;
    wake.demand();
    expect(relay.configChanges).toBe(before + 1);
    wake.evaluate();
    expect(relay.configChanges).toBe(before + 1);
  });
  it("keeps a report the phone sends while still connected, until it connects again", () => {
    pastGrace();
    relay.connectPhone(A, now);
    wake.evaluate();
    wake.unavailable(A, "data-cap");
    relay.connectedPhones = [];
    relay.activeKind = null;
    relay.activePhone = null;
    advance(SECOND);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "data-cap" });
    relay.connectPhone(A, now);
    advance(SECOND);
    expect(wake.phoneStatus(A).unavailable).toBeNull();
  });

  it("clears a report once a newer connection replaces the one that went dead", () => {
    pastGrace();
    relay.connectPhone(A, now);
    advance(SECOND);
    // Wi-Fi went away under the connection; the report came over the device route.
    wake.unavailable(A, "wifi-only");
    advance(30 * SECOND);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "wifi-only" });
    // Wi-Fi is back: the new connection replaces the dead one, with no gap in between.
    relay.connectPhone(A, now);
    advance(SECOND);
    expect(wake.phoneStatus(A).unavailable).toBeNull();
  });

  it("ignores a report that arrives after the phone said it was back", () => {
    pastGrace();
    wake.unavailable(A, "wifi-only", 1);
    relay.connectPhone(A, now);
    wake.available(A, 1);
    expect(wake.phoneStatus(A).unavailable).toBeNull();
    // The same report again, late from the device route, after the new connection began.
    advance(SECOND);
    wake.unavailable(A, "wifi-only", 1);
    expect(wake.phoneStatus(A).unavailable).toBeNull();
    // Once the phone leaves, it is woken again at once.
    relay.connectedPhones = [];
    relay.activeKind = null;
    relay.activePhone = null;
    leased = ["teammate-1"];
    advance(SECOND);
    expect(pushes.map((push) => push.stage)).toEqual(["wake"]);
    // A new report counts.
    wake.unavailable(A, "low-battery", 2);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "low-battery" });
  });

  it("keeps a report newer than what an `available` covers", () => {
    pastGrace();
    wake.unavailable(A, "stopped", 2);
    // The tunnel's message from before the report, processed after it.
    wake.available(A, 1);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "stopped" });
    wake.available(A, 2);
    expect(wake.phoneStatus(A).unavailable).toBeNull();
  });

  it("keeps a numbered report that a newer connection doesn't cover", () => {
    pastGrace();
    wake.unavailable(A, "stopped", 2);
    // A tunnel that covers report 1 only, adopted after report 2 arrived.
    advance(SECOND);
    relay.connectPhone(A, now);
    advance(SECOND);
    wake.available(A, 1);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "stopped" });
  });

  it("keeps the newer of two reports that arrive out of order", () => {
    pastGrace();
    wake.unavailable(A, "stopped", 2);
    wake.unavailable(A, "wifi-only", 1);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "stopped" });
    wake.available(A, 1);
    expect(wake.phoneStatus(A).unavailable).toMatchObject({ reason: "stopped" });
  });
});
