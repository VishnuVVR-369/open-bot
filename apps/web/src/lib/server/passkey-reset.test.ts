import { describe, expect, it, vi } from "vitest";
import { PASSKEY_RESET_MINUTES } from "@open-bot/shared";
import { noteUserVerification, openResetWindow } from "./passkey-reset";

function signIn() {
  const createVerificationValue = vi.fn(async () => ({}));
  const context = {
    newSession: { session: { id: "s1" }, user: { id: "u1" } },
    internalAdapter: { createVerificationValue },
  };
  return { context, createVerificationValue };
}

const verification = (userVerified: boolean) => ({ authenticationInfo: { userVerified } });

describe("passkey reset window", () => {
  it("opens for the new session when the device verified the person", async () => {
    const { context, createVerificationValue } = signIn();
    noteUserVerification({ ctx: { context }, verification: verification(true) });
    const now = new Date("2026-11-07T10:00:00Z");
    expect(await openResetWindow(context, now)).toBe(true);
    expect(createVerificationValue).toHaveBeenCalledWith({
      identifier: "passkey-reset:s1",
      value: "u1",
      expiresAt: new Date(now.getTime() + PASSKEY_RESET_MINUTES * 60_000),
    });
  });

  it("stays shut when the passkey only proved presence", async () => {
    const { context, createVerificationValue } = signIn();
    noteUserVerification({ ctx: { context }, verification: verification(false) });
    expect(await openResetWindow(context)).toBe(false);
    expect(createVerificationValue).not.toHaveBeenCalled();
  });

  it("stays shut for a request that verified someone else", async () => {
    const verified = signIn();
    noteUserVerification({ ctx: { context: verified.context }, verification: verification(true) });
    const other = signIn();
    expect(await openResetWindow(other.context)).toBe(false);
    expect(other.createVerificationValue).not.toHaveBeenCalled();
  });

  it("stays shut when no session was created", async () => {
    const { context, createVerificationValue } = signIn();
    noteUserVerification({ ctx: { context }, verification: verification(true) });
    const shut: { newSession: typeof context.newSession | null } = context;
    shut.newSession = null;
    expect(await openResetWindow(context)).toBe(false);
    expect(createVerificationValue).not.toHaveBeenCalled();
  });
});
