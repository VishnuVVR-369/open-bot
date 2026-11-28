import { expect, it } from "vitest";
import { foldDiff, lineDiff } from "./diff";

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

it("foldDiff keeps a few lines around each change and folds the long unchanged runs", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
  const after = ["1", "2", "3", "4", "5", "six", "7", "8", "9", "10"].join("\n");
  expect(foldDiff(lineDiff(before, after))).toEqual([
    { type: "folded", count: 3 },
    { type: "same", text: "4" },
    { type: "same", text: "5" },
    { type: "removed", text: "6" },
    { type: "added", text: "six" },
    { type: "same", text: "7" },
    { type: "same", text: "8" },
    { type: "folded", count: 2 },
  ]);
});

it("foldDiff shows a lone unchanged line between changes, and leaves a diff without changes", () => {
  // Folding one line saves no room, so it shows.
  const lines = lineDiff("a\nb\nc\nd\ne\nf\ng", "A\nb\nc\nd\ne\nf\nG");
  expect(foldDiff(lines)).toEqual(lines);
  expect(foldDiff(lineDiff("same\ntext", "same\ntext"))).toEqual(
    lineDiff("same\ntext", "same\ntext"),
  );
});
