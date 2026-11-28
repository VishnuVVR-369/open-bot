import { describe, expect, it } from "vitest";
import { holdScreenCapture } from "./capture-hold";

describe("keeping screens out of screenshots", () => {
  it("hides from the first screen that asks until the last one lets go", () => {
    const calls: string[] = [];
    const change = { prevent: () => calls.push("prevent"), allow: () => calls.push("allow") };
    const vault = holdScreenCapture(change);
    const editor = holdScreenCapture(change);
    expect(calls).toEqual(["prevent"]);
    // The editor closes over the vault: still hidden.
    editor();
    editor();
    expect(calls).toEqual(["prevent"]);
    vault();
    expect(calls).toEqual(["prevent", "allow"]);
    holdScreenCapture(change)();
    expect(calls).toEqual(["prevent", "allow", "prevent", "allow"]);
  });
});
