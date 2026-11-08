import { expect, it } from "vitest";
import { lineDiff } from "./diff";

it("lineDiff keeps order and marks what changed", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
    { type: "same", text: "a" },
    { type: "removed", text: "b" },
    { type: "added", text: "B" },
    { type: "same", text: "c" },
    { type: "added", text: "d" },
  ]);
  expect(lineDiff("", "new")).toEqual([{ type: "added", text: "new" }]);
  expect(lineDiff("same", "same")).toEqual([{ type: "same", text: "same" }]);
});
