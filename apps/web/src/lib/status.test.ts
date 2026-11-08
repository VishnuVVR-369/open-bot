import { describe, expect, it } from "vitest";
import {
  botActivity,
  botNeedsText,
  failureLine,
  isComputerOnline,
  runIsHeldBack,
  STATUS,
  teammateStatus,
} from "./status";

type Waiting = "approval" | "takeover" | null;
const bot = (status: "running" | "queued" | "waiting" | null, waitingFor: Waiting = null) => ({
  activeRun: status ? { id: "r", chatId: "c", status, waitingFor } : null,
});

describe("teammateStatus", () => {
  it("says what they are doing while the computer is online", () => {
    expect(teammateStatus(bot("running"))).toEqual({
      label: STATUS.working,
      activity: "working",
      needsYou: false,
    });
    expect(teammateStatus(bot("queued")).label).toBe(STATUS.upNext);
    expect(teammateStatus(bot(null))).toEqual({
      label: STATUS.idle,
      activity: "idle",
      needsYou: false,
    });
  });

  it("pauses everyone who doesn't need you while the computer is offline", () => {
    for (const status of ["running", "queued", null] as const) {
      expect(teammateStatus(bot(status), false)).toEqual({
        label: STATUS.paused,
        activity: "paused",
        needsYou: false,
      });
    }
  });

  it("still says a teammate needs you, online or not", () => {
    for (const online of [true, false]) {
      expect(teammateStatus(bot("waiting", "approval"), online)).toEqual({
        label: STATUS.approval,
        activity: "waiting",
        needsYou: true,
      });
      expect(teammateStatus(bot("waiting", "takeover"), online).label).toBe(STATUS.takeover);
    }
  });

  it("only ever uses the fixed words", () => {
    const words = new Set<string>(Object.values(STATUS));
    for (const status of ["running", "queued", "waiting", null] as const)
      for (const waitingFor of ["approval", "takeover", null] as const)
        for (const online of [true, false])
          expect(words.has(teammateStatus(bot(status, waitingFor), online).label)).toBe(true);
  });
});

describe("botActivity and botNeedsText", () => {
  it("agree with the status line", () => {
    expect(botActivity(bot("running"), false)).toBe("paused");
    expect(botActivity(bot(null), false)).toBe("paused");
    expect(botActivity(bot("waiting", "approval"), false)).toBe("waiting");
    expect(botNeedsText(bot("waiting", "takeover"))).toBe(STATUS.takeover);
    expect(botNeedsText(bot("running"))).toBeNull();
  });
});

describe("runIsHeldBack", () => {
  const now = Date.parse("2026-11-06T19:00:00Z");
  it("holds back a run whose time has passed while the computer is offline", () => {
    expect(runIsHeldBack("2026-11-06T16:00:00Z", now, false)).toBe(true);
    expect(runIsHeldBack("2026-11-07T16:00:00Z", now, false)).toBe(false);
    expect(runIsHeldBack("2026-11-06T16:00:00Z", now, true)).toBe(false);
  });
});

describe("isComputerOnline", () => {
  it("needs both the worker and the computer", () => {
    const state = (workerOnline: boolean, online: boolean) => ({
      computer: { workerOnline, online, lifecycle: null, health: null, egress: {} as never },
    });
    expect(isComputerOnline(state(true, true))).toBe(true);
    expect(isComputerOnline(state(true, false))).toBe(false);
    expect(isComputerOnline(state(false, true))).toBe(false);
    expect(isComputerOnline(undefined)).toBe(false);
  });

  it("counts a computer that is asleep, and wakes for the next task, as online", () => {
    const asleep = (workerOnline: boolean, enabled: boolean) => ({
      computer: {
        workerOnline,
        online: false,
        lifecycle: { enabled, phase: "idle" as const, error: null, demand: [], changedAt: "" },
        health: null,
        egress: {} as never,
      },
    });
    expect(isComputerOnline(asleep(true, true))).toBe(true);
    expect(isComputerOnline(asleep(true, false))).toBe(false);
    expect(isComputerOnline(asleep(false, true))).toBe(false);
  });
});

describe("failureLine", () => {
  it("says what happened, not what to do at the time", () => {
    expect(failureLine("The computer was restarting. Try again in a minute.")).toBe(
      "Interrupted when the computer restarted.",
    );
    expect(failureLine("The worker restarted while this was running.")).toBe(
      "Interrupted when the computer restarted.",
    );
  });

  it("drops stale advice and keeps the reason", () => {
    expect(failureLine("The site was down. Please try again later.")).toBe("The site was down.");
    expect(failureLine("Couldn't sign in to GitHub.")).toBe("Couldn't sign in to GitHub.");
  });

  it("has a line when there is no error", () => {
    expect(failureLine(null)).toBe("It stopped before it was done.");
    expect(failureLine("Try again in a minute.")).toBe("It stopped before it was done.");
  });
});
