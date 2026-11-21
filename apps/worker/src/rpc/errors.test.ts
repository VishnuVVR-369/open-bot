import { describe, expect, it } from "vitest";
import { WorkerError } from "../core/errors";
import { PageGone } from "../features/pages";
import { ScreenBusy } from "../features/screens";
import { SwarmError } from "../features/teamwork";
import { TelegramError } from "../features/telegram";
import { toRpcError } from "./errors";

describe("toRpcError", () => {
  it("answers a procedure with a worker error's own status and message", () => {
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
});
