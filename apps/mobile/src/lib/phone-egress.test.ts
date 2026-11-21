import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("../../modules/egress", () => ({ default: {} }));
vi.mock("./api", () => ({ api: { egress: {} } }));

import {
  parsePendingRevokes,
  releaseForSignOut,
  rememberRevoke,
  revokeOrRemember,
  sendPendingRevokes,
  signOutCount,
  type PendingRevoke,
  type RevokeStore,
  type SignOutEgressDeps,
} from "./phone-egress";

function memoryStore(initial: PendingRevoke[] = []): RevokeStore & { saved: () => unknown } {
  let value: string | null = JSON.stringify(initial);
  return {
    read: async () => value,
    write: async (next) => void (value = next),
    saved: () => JSON.parse(value ?? "[]"),
  };
}

function deps(overrides: Partial<SignOutEgressDeps> = {}) {
  const calls: string[] = [];
  const all: SignOutEgressDeps = {
    status: () => ({ paired: true, generation: 3 }),
    deviceId: () => "phone-1",
    forget: async () => void calls.push("forget"),
    revokeOrRemember: async (revoke) =>
      void calls.push(`revoke ${revoke.deviceId} ${revoke.generation}`),
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

  it("only makes sure the service is stopped when the phone isn't paired", async () => {
    const { all, calls } = deps({ status: () => ({ paired: false, generation: null }) });
    await releaseForSignOut(all);
    expect(calls).toEqual(["forget"]);
  });

  it("counts the sign-out first, so a pairing in progress knows not to finish", async () => {
    const before = signOutCount();
    let during = -1;
    const { all } = deps({ forget: async () => void (during = signOutCount()) });
    await releaseForSignOut(all);
    expect(during).toBe(before + 1);
  });
});

describe("revokes that couldn't reach the server", () => {
  it("are remembered for the pairing's generation when sending fails", async () => {
    const store = memoryStore();
    const result = await revokeOrRemember(
      { deviceId: "phone-1", generation: 3 },
      async () => {
        throw new Error("offline");
      },
      store,
    );
    expect(result).toBe("remembered");
    expect(store.saved()).toEqual([{ deviceId: "phone-1", generation: 3 }]);
  });

  it("are sent later and forgotten one by one, keeping the ones that still fail", async () => {
    const store = memoryStore([
      { deviceId: "phone-1", generation: 2 },
      { deviceId: "phone-2", generation: 5 },
    ]);
    const sent: string[] = [];
    await sendPendingRevokes(async (revoke) => {
      if (revoke.deviceId === "phone-2") throw new Error("offline");
      sent.push(`${revoke.deviceId} ${revoke.generation}`);
    }, store);
    expect(sent).toEqual(["phone-1 2"]);
    expect(store.saved()).toEqual([{ deviceId: "phone-2", generation: 5 }]);
  });

  it("keep a newer generation remembered while an older one is being sent", async () => {
    const store = memoryStore([{ deviceId: "phone-1", generation: 2 }]);
    await sendPendingRevokes(async () => {
      // An offline sign-out of a later pairing, while the old revoke is in flight.
      await rememberRevoke({ deviceId: "phone-1", generation: 3 }, store);
    }, store);
    expect(store.saved()).toEqual([{ deviceId: "phone-1", generation: 3 }]);
  });

  it("never include one without a generation, so a later pairing is safe", () => {
    expect(
      parsePendingRevokes(
        JSON.stringify([
          { deviceId: "phone-1" },
          { deviceId: "phone-1", generation: 0 },
          { deviceId: "phone-1", generation: 4 },
        ]),
      ),
    ).toEqual([{ deviceId: "phone-1", generation: 4 }]);
    expect(parsePendingRevokes("not json")).toEqual([]);
    expect(parsePendingRevokes(null)).toEqual([]);
  });
});
