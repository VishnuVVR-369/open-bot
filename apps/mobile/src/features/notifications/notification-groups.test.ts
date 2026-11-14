import { describe, expect, it } from "vitest";
import {
  collapseRepeats,
  notificationState,
  notificationText,
  stillNeedsYou,
} from "./notification-groups";

describe("repeated notifications", () => {
  const note = (id: string, title: string, botId: string | null = null, body = "") => ({
    id,
    kind: "cap_reached",
    title,
    body,
    teammateId: botId,
  });

  it("folds back-to-back repeats into one row", () => {
    const rows = collapseRepeats([
      note("1", "Cap reached"),
      note("2", "Cap reached"),
      note("3", "Rex replied", "rex", "Hi"),
      note("4", "Cap reached"),
    ]);
    expect(rows.map((row) => [row.key, row.items.length])).toEqual([
      ["1", 2],
      ["3", 1],
      ["4", 1],
    ]);
  });

  it("keeps rows apart when the text or teammate differs", () => {
    expect(
      collapseRepeats([note("1", "Replied", "rex", "a"), note("2", "Replied", "rex", "b")]),
    ).toHaveLength(2);
    expect(
      collapseRepeats([note("1", "Replied", "rex"), note("2", "Replied", "iris")]),
    ).toHaveLength(2);
  });
});

describe("notification words", () => {
  it("quotes the task a failure names, so it reads as a name", () => {
    expect(
      notificationText({
        kind: "run_failed",
        title: "Kit couldn't finish: GitHub release published",
        body: "The computer was restarting.",
      }),
    ).toEqual({
      title: "Kit couldn't finish “GitHub release published”",
      body: "The computer was restarting.",
    });
  });

  it("leaves everything else as written", () => {
    const plain = { kind: "run_failed", title: "Kit couldn't finish", body: "It failed." };
    expect(notificationText(plain)).toEqual({ title: plain.title, body: plain.body });
    const other = { kind: "run_finished", title: "Iris finished: launch status", body: "" };
    expect(notificationText(other)).toEqual({ title: other.title, body: other.body });
  });
});

describe("notificationState", () => {
  const base = { runId: "r1", teammateId: "iris", createdAt: "2026-11-06T10:00:00Z" };
  it("finds how the approval a notification asked about was decided", () => {
    expect(
      notificationState(
        { ...base, kind: "approval" },
        [
          { runId: "r1", status: "approved", createdAt: "2026-11-06T09:59:59Z" },
          { runId: "r1", status: "pending", createdAt: "2026-11-06T11:00:00Z" },
          { runId: "r2", status: "denied", createdAt: "2026-11-06T10:00:00Z" },
        ],
        [],
      ),
    ).toEqual({ kind: "approval", status: "approved" });
  });

  it("says a takeover is pending only while it waits", () => {
    const takeover = { ...base, kind: "takeover_request", teammateId: "juno" };
    expect(notificationState(takeover, [], [{ teammateId: "juno" }])).toEqual({
      kind: "takeover",
      status: "pending",
    });
    expect(notificationState(takeover, [], [])).toBeNull();
  });

  it("needs you only while a request is open", () => {
    expect(
      stillNeedsYou({ kind: "approval", readAt: null }, { kind: "approval", status: "denied" }),
    ).toBe(false);
    expect(
      stillNeedsYou({ kind: "approval", readAt: "x" }, { kind: "approval", status: "pending" }),
    ).toBe(true);
    expect(stillNeedsYou({ kind: "run_finished", readAt: null }, null)).toBe(false);
  });
});
