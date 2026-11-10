import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";
import { attempt, UNREACHABLE } from "./mutate";

describe("attempt", () => {
  it("passes on what the write answered", async () => {
    expect(await attempt(Promise.resolve({ chatId: "c" }))).toEqual({
      ok: true,
      data: { chatId: "c" },
    });
  });

  it("shows the server's own message", async () => {
    const refused = new ORPCError("BAD_REQUEST", { message: "Name the chat." });
    expect(await attempt(Promise.reject(refused))).toEqual({ ok: false, error: "Name the chat." });
  });

  it("says the server can't be reached when fetch fails", async () => {
    const offline = new TypeError("Failed to fetch");
    expect(await attempt(Promise.reject(offline))).toEqual({ ok: false, error: UNREACHABLE });
  });

  it("sends a signed-out tab to sign in", async () => {
    const signedOut = vi.fn();
    const gone = new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
    expect(await attempt(Promise.reject(gone), signedOut)).toEqual({
      ok: false,
      error: "Sign in first.",
    });
    expect(signedOut).toHaveBeenCalledOnce();
  });
});
