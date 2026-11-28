import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

describe("leaving a screen that asks first", () => {
  // Expo Router's `usePreventRemove` blocks the blocked action again when it's dispatched as is,
  // so "Discard" asked the same question forever. Its callback's `repeat` lets it through.
  it("lets the blocked leave through with repeat, never by dispatching it again", () => {
    const offenders = files(root)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          source.includes("usePreventRemove(") && /dispatch\(\s*data\.action\s*\)/.test(source)
        );
      })
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
