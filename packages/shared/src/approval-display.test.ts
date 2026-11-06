import { describe, expect, it } from "vitest";
import { approvalAmount, approvalRisk, approveLabel, detailFields } from "./approval-display";

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
