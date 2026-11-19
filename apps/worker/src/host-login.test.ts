import { describe, expect, it, vi } from "vitest";
import { refreshHostLogin } from "./host-login";
import type { Logger } from "./logger";

describe("refreshHostLogin", () => {
  it("fails, without ending the worker, when the Codex CLI isn't there", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await expect(
      refreshHostLogin("/nonexistent/.codex/auth.json", "/nonexistent/codex", log),
    ).rejects.toThrow("The Codex CLI on this Mac didn't start: spawn /nonexistent/codex ENOENT");
    expect(log.warn).toHaveBeenCalledWith("could not refresh this Mac's Codex login", {
      error: "The Codex CLI on this Mac didn't start: spawn /nonexistent/codex ENOENT",
    });
  });
});
