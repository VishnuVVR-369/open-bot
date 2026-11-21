import { beforeEach, describe, expect, it, vi } from "vitest";

const { storage, revokeDevice } = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  revokeDevice: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));
vi.mock("../../modules/egress", () => ({ default: {} }));
vi.mock("./api", () => ({ api: { egress: { revokeDevice } } }));

import {
  parsePendingRevoke,
  releaseForSignOut,
  sendPendingRevoke,
  type SignOutEgressDeps,
} from "./phone-egress";

beforeEach(() => {
  storage.clear();
  vi.resetAllMocks();
});

function deps(overrides: Partial<SignOutEgressDeps> = {}) {
  const calls: string[] = [];
  const all: SignOutEgressDeps = {
    status: () => ({ paired: true, generation: 3 }),
    deviceId: () => "phone-1",
    forget: async () => void calls.push("forget"),
    revoke: async (revoke) => void calls.push(`revoke ${revoke.deviceId} ${revoke.generation}`),
    remember: async (revoke) => void calls.push(`remember ${revoke.deviceId} ${revoke.generation}`),
    ...overrides,
  };
  return { all, calls };
}

describe("the phone connection at sign-out", () => {
  it("stops the service and forgets the credential before revoking with the session", async () => {
    const { all, calls } = deps();
    await releaseForSignOut(all);
    expect(calls).toEqual(["forget", "revoke phone-1 3"]);
  });

  it("remembers a revoke that couldn't be sent, for this pairing's generation", async () => {
    const { all, calls } = deps({
      revoke: async () => {
        throw new Error("offline");
      },
    });
    await releaseForSignOut(all);
    expect(calls).toEqual(["forget", "remember phone-1 3"]);
  });

  it("only makes sure the service is stopped when the phone isn't paired", async () => {
    const { all, calls } = deps({ status: () => ({ paired: false, generation: null }) });
    await releaseForSignOut(all);
    expect(calls).toEqual(["forget"]);
  });
});

describe("a revoke left by an offline sign-out", () => {
  it("is sent after the next sign-in and then forgotten", async () => {
    storage.set(
      "openbot:egress-pending-revoke",
      JSON.stringify({ deviceId: "phone-1", generation: 2 }),
    );
    revokeDevice.mockResolvedValue({ ok: true });
    await sendPendingRevoke();
    expect(revokeDevice).toHaveBeenCalledWith({ deviceId: "phone-1", generation: 2 });
    expect(storage.size).toBe(0);
  });

  it("stays remembered while the server can't be reached", async () => {
    storage.set(
      "openbot:egress-pending-revoke",
      JSON.stringify({ deviceId: "phone-1", generation: 2 }),
    );
    revokeDevice.mockRejectedValue(new Error("offline"));
    await expect(sendPendingRevoke()).rejects.toThrow("offline");
    expect(storage.size).toBe(1);
  });

  it("never revokes without a generation, so a later pairing is safe", () => {
    expect(parsePendingRevoke(JSON.stringify({ deviceId: "phone-1" }))).toBeNull();
    expect(parsePendingRevoke(JSON.stringify({ deviceId: "phone-1", generation: 0 }))).toBeNull();
    expect(parsePendingRevoke("not json")).toBeNull();
    expect(parsePendingRevoke(null)).toBeNull();
  });
});
