import { describe, expect, it } from "vitest";
import { botActivity, botSubtitle, failureLine, isComputerOnline, PAUSED_OFFLINE } from "./status";

const run = (status: "running" | "queued" | "waiting", waitingFor: "approval" | null = null) => ({
  activeRun: { id: "r", chatId: "c", status, waitingFor },
  role: "Research assistant",
});

describe("botActivity", () => {
  it("pauses work in progress while the computer is offline", () => {
    expect(botActivity(run("running"))).toBe("working");
    expect(botActivity(run("running"), false)).toBe("paused");
    expect(botActivity(run("queued"), false)).toBe("paused");
  });

  it("still says a teammate needs you while offline", () => {
    expect(botActivity(run("waiting", "approval"), false)).toBe("waiting");
    expect(botSubtitle(run("waiting", "approval"), false)).toBe("Needs your approval");
  });

  it("says why the work isn't moving", () => {
    expect(botSubtitle(run("running"), false)).toBe(PAUSED_OFFLINE);
    expect(botSubtitle(run("running"), true)).toBe("Research assistant");
    expect(botSubtitle({ activeRun: null, role: "Writer" }, false)).toBe("Writer");
  });
});

describe("isComputerOnline", () => {
  it("needs both the worker and the computer", () => {
    const state = (workerOnline: boolean, online: boolean) => ({
      computer: { workerOnline, online, health: null, egress: {} as never },
    });
    expect(isComputerOnline(state(true, true))).toBe(true);
    expect(isComputerOnline(state(true, false))).toBe(false);
    expect(isComputerOnline(state(false, true))).toBe(false);
    expect(isComputerOnline(undefined)).toBe(false);
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
