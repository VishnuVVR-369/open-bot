import { describe, expect, it } from "vitest";
import {
  approvalQuotes,
  invalidRulePattern,
  rulesCover,
  shellScript,
  simpleCommands,
  suggestedRule,
  type ApprovalRule,
} from "./approval-rules";

const command = (pattern: string): ApprovalRule => ({ kind: "command", pattern });

describe("shell scripts", () => {
  it("unwrap the shell Codex runs commands in", () => {
    expect(shellScript("/bin/bash -lc 'cat MEMORY.md'")).toBe("cat MEMORY.md");
    expect(shellScript(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(shellScript(`/bin/zsh -lc "echo \\"hi\\""`)).toBe(`echo "hi"`);
    expect(shellScript("sh -c ls")).toBe("ls");
    expect(shellScript("git status")).toBe("git status");
  });

  it("split into simple commands, and give up on redirects and substitutions", () => {
    expect(simpleCommands("git status && git diff | head; ls & pwd")).toEqual([
      "git status",
      "git diff",
      "head",
      "ls",
      "pwd",
    ]);
    expect(simpleCommands("echo hi > /etc/passwd")).toBeNull();
    expect(simpleCommands("echo $(rm -rf ~)")).toBeNull();
    expect(simpleCommands("echo `rm -rf ~`")).toBeNull();
  });
});

describe("always-allow rules", () => {
  it("match commands by their start, on word boundaries", () => {
    const rules = [command("git status")];
    expect(rulesCover(rules, "command", "git status")).toBe(true);
    expect(rulesCover(rules, "command", "git  status --short")).toBe(true);
    expect(rulesCover(rules, "command", "/bin/bash -lc 'git status'")).toBe(true);
    expect(rulesCover(rules, "command", "git statusx")).toBe(false);
    expect(rulesCover(rules, "command", "git push")).toBe(false);
    expect(rulesCover(rules, "action", "git status")).toBe(false);
  });

  it("need every chained command to be allowed", () => {
    const rules = [command("git status"), command("ls")];
    expect(rulesCover(rules, "command", "/bin/bash -lc 'git status && ls -la'")).toBe(true);
    expect(rulesCover(rules, "command", "/bin/bash -lc 'git status && rm -rf ~'")).toBe(false);
    expect(rulesCover(rules, "command", "/bin/bash -lc 'git status; rm -rf ~'")).toBe(false);
    expect(rulesCover(rules, "command", "/bin/bash -lc 'git status > notes.txt'")).toBe(false);
    expect(rulesCover(rules, "command", "/bin/bash -lc 'ls $(rm -rf ~)'")).toBe(false);
  });

  it("match actions by their wording, ignoring case and spacing", () => {
    const rules: ApprovalRule[] = [{ kind: "action", pattern: "Reply to Dana's emails" }];
    expect(rulesCover(rules, "action", "  reply to dana's   emails ")).toBe(true);
    expect(rulesCover(rules, "action", "Reply to Sam's emails")).toBe(false);
  });

  it("cover every file change", () => {
    expect(rulesCover([{ kind: "file_change", pattern: "" }], "file_change", "Change a.txt")).toBe(
      true,
    );
    expect(rulesCover([command("ls")], "file_change", "Change a.txt")).toBe(false);
  });

  it("suggest the first command's program and subcommand", () => {
    expect(suggestedRule("command", "npm run build -- --prod")).toBe("npm run");
    expect(suggestedRule("command", "/bin/bash -lc 'git log --oneline && ls'")).toBe("git log");
    expect(suggestedRule("action", " Send the weekly report ")).toBe("Send the weekly report");
    expect(suggestedRule("file_change", "Change a.txt")).toBe("");
  });

  it("refuse patterns that would allow too much", () => {
    expect(invalidRulePattern("command", "git status")).toBeNull();
    expect(invalidRulePattern("command", "")).not.toBeNull();
    expect(invalidRulePattern("command", "/bin/bash -lc")).not.toBeNull();
    expect(invalidRulePattern("command", "bash")).not.toBeNull();
    expect(invalidRulePattern("command", "ls && rm")).not.toBeNull();
    expect(invalidRulePattern("action", "Send the report")).toBeNull();
    expect(invalidRulePattern("file_change", "")).toBeNull();
  });
});

describe("approvals that quote a command", () => {
  const approved =
    "Delete /home/bot/shared/ux-check2.txt\nRun rm -f -- /home/bot/shared/ux-check2.txt to delete the file if it exists.";

  it("cover that exact command, however Codex wraps it", () => {
    expect(approvalQuotes(approved, "rm -f -- /home/bot/shared/ux-check2.txt")).toBe(true);
    expect(
      approvalQuotes(approved, "/bin/bash -lc 'rm -f -- /home/bot/shared/ux-check2.txt'"),
    ).toBe(true);
    expect(approvalQuotes("Run `rm -rf build`.", "rm -rf build")).toBe(true);
    expect(approvalQuotes("Clean up: rm -rf build", "rm  -rf\nbuild")).toBe(true);
  });

  it("don't cover a different or longer command", () => {
    expect(approvalQuotes(approved, "rm -f -- /home/bot/shared/ux-check2")).toBe(false);
    expect(approvalQuotes(approved, "rm -f -- /home/bot/shared")).toBe(false);
    expect(approvalQuotes(approved, "rm -f -- /home/bot/shared/ux-check2.txt; rm -rf ~")).toBe(
      false,
    );
    expect(approvalQuotes("Delete old-notes.txt", "rm -f old-notes.txt")).toBe(false);
    expect(approvalQuotes("anything", "")).toBe(false);
    expect(approvalQuotes("Run xrm -f a", "rm -f a")).toBe(false);
  });
});
