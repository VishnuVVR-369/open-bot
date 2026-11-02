import { beforeEach, describe, expect, it, vi } from "vitest";

const { request, create, get } = vi.hoisted(() => ({
  request: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock("expo-device", () => ({ modelName: "Test phone" }));
vi.mock("./auth", () => ({ authClient: { $fetch: request } }));
vi.mock("../../modules/passkey", () => ({
  NativePasskey: { create, get },
  passkeyFailure: (error: { code?: string }) => error?.code ?? "failed",
}));

import { addPasskey, signInWithPasskey } from "./passkey";

beforeEach(() => vi.resetAllMocks());

describe("the native passkey ceremony", () => {
  it("uses the cookie-aware auth client for both registration requests", async () => {
    const options = { challenge: "register", rp: { id: "openbot.example" } };
    request.mockResolvedValueOnce({ data: options }).mockResolvedValueOnce({ data: {} });
    create.mockResolvedValue(JSON.stringify({ id: "new-passkey" }));

    expect(await addPasskey()).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith(JSON.stringify(options));
    expect(request.mock.calls).toEqual([
      ["/passkey/generate-register-options", { method: "GET" }],
      [
        "/passkey/verify-registration",
        { method: "POST", body: { response: { id: "new-passkey" }, name: "Test phone" } },
      ],
    ]);
  });

  it("verifies the native assertion through the same auth client to save the session", async () => {
    const options = { challenge: "authenticate", rpId: "openbot.example" };
    request.mockResolvedValueOnce({ data: options }).mockResolvedValueOnce({ data: {} });
    get.mockResolvedValue(JSON.stringify({ id: "existing-passkey" }));

    expect(await signInWithPasskey()).toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith(JSON.stringify(options));
    expect(request.mock.calls).toEqual([
      ["/passkey/generate-authenticate-options", { method: "GET" }],
      [
        "/passkey/verify-authentication",
        { method: "POST", body: { response: { id: "existing-passkey" } } },
      ],
    ]);
  });

  it("treats cancellation as a quiet exit without verifying anything", async () => {
    request.mockResolvedValue({ data: { challenge: "register" } });
    create.mockRejectedValue({ code: "cancelled" });

    expect(await addPasskey()).toEqual({ ok: false, message: null });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("explains that a passkey must be added first", async () => {
    request.mockResolvedValue({ data: { challenge: "authenticate" } });
    get.mockRejectedValue({ code: "none" });

    expect(await signInWithPasskey()).toEqual({
      ok: false,
      message: "There's no open-bot passkey on this phone yet.",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh session before opening the registration prompt", async () => {
    request.mockResolvedValue({ error: { code: "SESSION_NOT_FRESH" } });

    expect(await addPasskey()).toEqual({
      ok: false,
      message: "Sign in again with your password, then add the passkey.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not claim success when verification loses the network", async () => {
    request
      .mockResolvedValueOnce({ data: { challenge: "authenticate" } })
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    get.mockResolvedValue(JSON.stringify({ id: "existing-passkey" }));

    expect(await signInWithPasskey()).toEqual({
      ok: false,
      message: "Couldn't reach open-bot. Check your connection.",
    });
  });
});
