import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toRpcError } from "../rpc/errors";
import { PageGone } from "../features/pages";
import { ScreenBusy } from "../features/screens";
import { SwarmError } from "../features/teamwork";
import { TelegramError } from "../features/telegram";
import { WorkerError } from "./errors";

const SOURCE = path.join(import.meta.dirname, "..");

/** Errors that never reach a caller, so they need no status. */
const INTERNAL = new Set(["CheckProblem"]);

describe("worker errors", () => {
  it("answer a procedure with their own status and message", () => {
    for (const [error, status] of [
      [new SwarmError("That swarm is done."), 400],
      [new TelegramError("Telegram isn't connected.", 401), 400],
      [new PageGone(), 404],
      [new ScreenBusy(), 409],
    ] as const) {
      expect(error).toBeInstanceOf(WorkerError);
      expect(toRpcError(error)).toMatchObject({ status, message: error.message });
    }
    expect(toRpcError(new Error("socket hang up"))).toMatchObject({ status: 500 });
  });

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
