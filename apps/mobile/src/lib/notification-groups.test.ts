import { describe, expect, it } from "vitest";
import { collapseRepeats, notificationText } from "./notification-groups";

describe("repeated notifications", () => {
  const note = (id: string, title: string, botId: string | null = null, body = "") => ({
    id,
    kind: "cap_reached",
    title,
    body,
    botId,
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
