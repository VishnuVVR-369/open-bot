import { describe, expect, it } from "vitest";
import { approvalRisk, commandParts, shortenPaths, titleParts } from "./approval-text";

describe("approval titles", () => {
  it("splits out code quoted in backticks", () => {
    expect(titleParts("Run `ls -la /tmp`")).toEqual([
      { text: "Run ", code: false },
      { text: "ls -la /tmp", code: true },
    ]);
    expect(titleParts("Buy a server")).toEqual([{ text: "Buy a server", code: false }]);
    expect(titleParts("Run `half")).toEqual([{ text: "Run `half", code: false }]);
  });

  it("keeps the end of long paths, where they differ", () => {
    expect(shortenPaths("Delete /home/bot/shared/old-notes.txt")).toBe(
      "Delete /home/bot/shared/old-notes.txt",
    );
    expect(
      shortenPaths("Delete /home/bot/shared/projects/2026/reports/quarterly/old-report-final.txt"),
    ).toBe("Delete /home/…/quarterly/old-report-final.txt");
    expect(
      shortenPaths("Run `rm -rf /tmp/openbot-approval-test/nested/deeper/folder/file.log`", 40),
    ).toBe("Run `rm -rf /tmp/…/folder/file.log`");
  });
});

describe("command details", () => {
  it("reads the reason, the command and where it runs", () => {
    expect(
      commandParts("Check the folder\n$ bash -lc 'ls -la /home/bot'\nin /home/bot/shared"),
    ).toEqual({ reason: "Check the folder", command: "ls -la /home/bot", cwd: "/home/bot/shared" });
    expect(commandParts("$ pwd")).toEqual({ reason: null, command: "pwd", cwd: null });
    expect(commandParts("Just words")).toEqual({ reason: "Just words", command: null, cwd: null });
  });
});

describe("approval risk", () => {
  const command = (subject: string) => ({ kind: "command", title: "", detail: "", subject });

  it("flags commands that delete or overwrite", () => {
    for (const risky of [
      "rm -rf /tmp/x",
      "cd /tmp && rm old.txt",
      "sudo rm /etc/thing",
      "bash -lc 'rm -f a'",
      "find . -name '*.log' -delete",
      "git push --force origin main",
      "git reset --hard HEAD~1",
      "psql -c 'DROP TABLE users'",
      "dd if=/dev/zero of=/dev/sda",
    ])
      expect(approvalRisk(command(risky))?.tone, risky).toBe("destructive");
  });

  it("leaves everyday commands alone", () => {
    for (const fine of ["pwd", "ls -la /home/bot", "npm run format", "git push origin main"])
      expect(approvalRisk(command(fine)), fine).toBeNull();
  });

  it("flags deleting, spending and sending", () => {
    expect(
      approvalRisk({ kind: "file_change", title: "Delete old-report.txt", detail: "" })?.tone,
    ).toBe("destructive");
    expect(approvalRisk({ kind: "action", title: "Create a teammate", detail: "" })).toBeNull();
    expect(approvalRisk({ kind: "purchase", title: "Buy", detail: "" })?.tone).toBe("attention");
    expect(approvalRisk({ kind: "email", title: "Email a", detail: "" })?.tone).toBe("attention");
  });
});

describe("account approvals", () => {
  it("says when a teammate acts as you, and when that deletes something", () => {
    expect(
      approvalRisk({ kind: "account_outward", title: "Send “Notes” to Priya", detail: "" }),
    ).toMatchObject({ tone: "attention", label: "Acts as you" });
    expect(
      approvalRisk({ kind: "account_outward", title: "Delete “Design review”", detail: "" }),
    ).toMatchObject({ tone: "destructive" });
    expect(
      approvalRisk({
        kind: "account_write",
        title: "Add “Weekly review” to your calendar",
        detail: "",
      }),
    ).toBeNull();
  });
});
