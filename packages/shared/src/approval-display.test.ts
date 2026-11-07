import { describe, expect, it } from "vitest";
import {
  approvalAmount,
  approvalCommand,
  approvalHeadline,
  approvalRisk,
  approveLabel,
  commandSummary,
  detailFields,
} from "./approval-display";

describe("approveLabel", () => {
  it("names the amount a purchase pays", () => {
    expect(
      approveLabel({ kind: "purchase", title: "Pay $842.30 to TAP Air Portugal", detail: "" }),
    ).toBe("Approve $842.30");
    expect(approveLabel({ kind: "purchase", title: "Pay $1,200 at Delta", detail: "" })).toBe(
      "Approve $1,200",
    );
    expect(approveLabel({ kind: "purchase", title: "Buy the tickets", detail: "" })).toBe(
      "Approve payment",
    );
  });

  it("says an email gets sent", () => {
    expect(approveLabel({ kind: "email", title: "Reply to Sam", detail: "" })).toBe(
      "Approve and send",
    );
    expect(
      approveLabel({
        kind: "account_outward",
        title: "Send an email",
        detail: "",
        previewType: "email",
      }),
    ).toBe("Approve and send");
    expect(approveLabel({ kind: "command", title: "Run `ls`", detail: "" })).toBe("Approve");
  });
});

describe("approvalAmount", () => {
  it("reads the amount from the start of the title only", () => {
    expect(approvalAmount("Pay $42 at Shop")).toBe("$42");
    expect(approvalAmount("Refund $42 to Sam")).toBeNull();
  });
});

describe("approvalRisk", () => {
  it("flags money, email and deletes", () => {
    expect(approvalRisk({ kind: "purchase", title: "Pay $5 at X", detail: "" })?.label).toBe(
      "Spends money",
    );
    expect(
      approvalRisk({ kind: "account_outward", title: "Send", detail: "", previewType: "email" })
        ?.label,
    ).toBe("Sends an email");
    expect(approvalRisk({ kind: "command", title: "Run", detail: "$ rm -rf /tmp/x" })?.tone).toBe(
      "destructive",
    );
    expect(approvalRisk({ kind: "command", title: "Run", detail: "$ ls" })).toBeNull();
  });
});

describe("detailFields", () => {
  it("splits labeled lines into fields", () => {
    const { text, fields } = detailFields(
      "Round trip SFO to LIS, nonstop.\nOut: Mon Nov 30, 6:15 PM.\nBack: Sat Dec 5, 11:40 AM.\nCard: Travel Amex (•••• 1007)",
    );
    expect(text).toEqual(["Round trip SFO to LIS, nonstop."]);
    expect(fields).toEqual([
      { label: "Out", value: "Mon Nov 30, 6:15 PM" },
      { label: "Back", value: "Sat Dec 5, 11:40 AM" },
      { label: "Card", value: "Travel Amex (•••• 1007)" },
    ]);
  });

  it("keeps prose and commands as they are", () => {
    expect(detailFields("Note: this is just one sentence.").fields).toEqual([]);
    expect(detailFields("Why: tidy up\nWhere: home\n$ rm x").fields).toEqual([]);
  });
});

describe("commandSummary", () => {
  it.each([
    ["git push -u origin fix/dst-recurrence", "Push the fix/dst-recurrence branch"],
    ["rm -rf /home/bot/shared/downloads/*", "Delete downloads"],
    [
      "pg_dump --schema-only kestrel_staging > /home/bot/schema.sql",
      "Export the kestrel_staging database",
    ],
    ["/bin/bash -lc 'cd repo && pnpm install'", "Install packages"],
    ["sudo rm a.txt b.txt", "Delete 2 items"],
    ["gh pr create --fill", "Open a pull request"],
    ["git add -A && git commit -m wip && git push", "Run git add, then 2 more"],
    ["python3 scripts/run.py", "Run python3"],
    [
      "gh pr list --state merged --search 'merged:>2026-09-01' --limit 60 --json title,number",
      "List pull requests",
    ],
    ["gh pr view 58", "Look at a pull request"],
    ["sed -n '1,30p' /home/bot/shared/kestrel/CHANGELOG-2.0.md", "Read CHANGELOG-2.0.md"],
    ["sed -i 's/a/b/' src/app.ts", "Edit app.ts"],
    ["cat package.json", "Read package.json"],
    ["head -n 20 notes.md", "Read notes.md"],
    ["rg TODO src", "Search files"],
    ["git status --short", "Check what changed"],
  ])("%s", (command, expected) => {
    expect(commandSummary(command)).toBe(expected);
  });
});

describe("approvalHeadline", () => {
  it("leads a worker's command approval with what it does", () => {
    const approval = {
      kind: "command",
      title: "Run `git push -u origin fix/dst-recurrence`",
      detail: "Ship the fix\n$ git push -u origin fix/dst-recurrence\nin /home/bot/repo",
      subject: "/bin/bash -lc 'git push -u origin fix/dst-recurrence'",
    };
    expect(approvalHeadline(approval)).toEqual({
      title: "Push the fix/dst-recurrence branch",
      command: "git push -u origin fix/dst-recurrence",
    });
  });

  it("takes the command from a bare title when the detail is only a reason", () => {
    const approval = {
      kind: "command",
      title: "rm -rf /home/bot/shared/downloads/*",
      detail: "Frees about 2 GB by clearing the downloads folder.",
      subject: "rm",
    };
    expect(approvalHeadline(approval)).toEqual({
      title: "Delete downloads",
      command: "rm -rf /home/bot/shared/downloads/*",
    });
  });

  it("prefers the whole command in the detail over a title cut short", () => {
    const long = `echo ${"x".repeat(100)}`;
    expect(
      approvalCommand({
        kind: "command",
        title: `Run \`${long.slice(0, 80)}…\``,
        detail: `$ ${long}`,
      }),
    ).toBe(long);
  });

  it("keeps other approvals' titles", () => {
    expect(
      approvalHeadline({ kind: "purchase", title: "Pay $842.30 to TAP", detail: "Round trip" }),
    ).toEqual({ title: "Pay $842.30 to TAP", command: null });
  });
});
