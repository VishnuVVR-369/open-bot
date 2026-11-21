import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");

/** Errors that never reach a caller, so they need no status. */
const INTERNAL = new Set(["CheckProblem"]);

describe("worker errors", () => {
  it("all extend WorkerError, so procedures and tools map them in one place", () => {
    const own: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/(?<!\.test)\.ts$/.test(entry.name))
          for (const [, name] of readFileSync(file, "utf8").matchAll(
            /class (\w+) extends Error\b/g,
          ))
            if (
              path.relative(SOURCE, file) !== path.join("core", "errors.ts") &&
              !INTERNAL.has(name!)
            )
              own.push(`${path.relative(SOURCE, file)}: ${name}`);
      }
    };
    walk(SOURCE);
    expect(own).toEqual([]);
  });
});
