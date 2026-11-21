import type { EgressStatusView } from "@open-bot/api";
import type { PhoneMode } from "@open-bot/domain";
import { describe, expect, it } from "vitest";
import type { EgressNativeStatus } from "../../../modules/egress";
import {
  capLabel,
  lastUsedLabel,
  needsBatteryHelp,
  pairPhone,
  phoneState,
  removedOnServer,
  turnOffThisPhone,
  type PairDeps,
} from "./phone-connection";

function native(overrides: {
  paired?: boolean;
  phoneMode?: PhoneMode;
  run?: Partial<EgressNativeStatus["run"]>;
  service?: Partial<EgressNativeStatus["service"]>;
}): EgressNativeStatus {
  return {
    paired: overrides.paired ?? true,
    generation: 1,
    phoneMode: overrides.phoneMode ?? "fallback",
    run: { phase: "off", reason: null, since: 0, ...overrides.run },
    service: {
      running: false,
      connection: null,
      detail: null,
      role: null,
      network: null,
      stats: null,
      ...overrides.service,
    },
    usage: { todayBytes: 0, monthBytes: 0, monthMeteredBytes: 0 },
    rules: { wifiOnly: true, monthlyCapBytes: 2e9, lowBatteryPause: true },
  };
}

describe("this phone's state in words", () => {
  it("says it carries browsing, and on which network", () => {
    expect(
      phoneState(
        native({
          run: { phase: "running" },
          service: { running: true, connection: "online", role: "active", network: "wifi" },
        }),
      ),
    ).toEqual({ label: "Carrying teammates' browsing", detail: "On Wi-Fi", tone: "active" });
  });

  it("says it stands by while the Mac carries the traffic", () => {
    expect(
      phoneState(native({ service: { running: true, connection: "online", role: "standby" } }))
        .label,
    ).toBe("Standing by");
  });

  it("says why it paused", () => {
    expect(phoneState(native({ run: { phase: "paused", reason: "data-cap" } }))).toMatchObject({
      label: "Paused",
      detail: "This month's mobile data limit is reached.",
      tone: "attention",
    });
  });

  it("tells a stop in `always` from one that a wake can undo", () => {
    expect(phoneState(native({ run: { phase: "stopped" }, phoneMode: "always" })).detail).toBe(
      "It stays off until you start it again.",
    );
    expect(phoneState(native({ run: { phase: "stopped" } })).detail).toMatch(/15 minutes/);
  });

  it("is ready in `fallback`, and needs starting in `always`", () => {
    expect(phoneState(native({})).label).toBe("Ready");
    expect(phoneState(native({ phoneMode: "always" })).tone).toBe("attention");
  });

  it("says it was turned off elsewhere after a revoke", () => {
    expect(phoneState(native({ paired: false, run: { phase: "revoked" } }))).toMatchObject({
      label: "Turned off",
      tone: "attention",
    });
    expect(phoneState(native({ paired: false })).label).toBe("Off");
  });
});

function pairDeps(overrides: Partial<PairDeps> = {}) {
  const calls: string[] = [];
  const deps: PairDeps = {
    notifications: async () => ({ permission: true, connection: true }),
    deviceId: () => "phone-1",
    deviceName: () => "Pixel",
    pushToken: async () => "fcm-token",
    serverPhoneMode: "off",
    register: async (input) => {
      calls.push(`register ${input.deviceId} ${input.name} ${input.pushToken}`);
      return { secret: "s3cret", generation: 4 };
    },
    setServerPhoneMode: async (mode) => void calls.push(`server mode ${mode}`),
    pair: async (options) =>
      void calls.push(`pair ${options.secret} ${options.generation} ${options.phoneMode}`),
    forgetIfMine: async (generation) => void calls.push(`forget ${generation}`),
    onRegistered: () => void calls.push("registered"),
    revokeOrRemember: async (input) =>
      void calls.push(`revoke ${input.deviceId} ${input.generation}`),
    stillSignedIn: () => true,
    ...overrides,
  };
  return { deps, calls };
}

const fail = (message: string) => async () => {
  throw new Error(message);
};

describe("pairing this phone", () => {
  it("registers, hands the credential to the service, then turns phones on as a fallback", async () => {
    const { deps, calls } = pairDeps();
    expect(await pairPhone(deps)).toEqual({ ok: true });
    expect(calls).toEqual([
      "register phone-1 Pixel fcm-token",
      "registered",
      "pair s3cret 4 fallback",
      "server mode fallback",
    ]);
  });

  it("keeps the phone mode the owner chose", async () => {
    const { deps, calls } = pairDeps({ serverPhoneMode: "always" });
    await pairPhone(deps);
    expect(calls).toEqual([
      "register phone-1 Pixel fcm-token",
      "registered",
      "pair s3cret 4 always",
    ]);
  });

  it("stops before registering when the notices would be invisible", async () => {
    const blocked = pairDeps({
      notifications: async () => ({ permission: false, connection: true }),
    });
    expect(await pairPhone(blocked.deps)).toEqual({ ok: false, problem: "permission" });
    const channel = pairDeps({
      notifications: async () => ({ permission: true, connection: false }),
    });
    expect(await pairPhone(channel.deps)).toEqual({ ok: false, problem: "channel" });
    expect([...blocked.calls, ...channel.calls]).toEqual([]);
  });

  it("pairs without a push token when Firebase has none", async () => {
    const { deps, calls } = pairDeps({ pushToken: fail("no Firebase") });
    await pairPhone(deps);
    expect(calls[0]).toBe("register phone-1 Pixel null");
  });

  it("undoes the pairing on both sides when the phone can't keep the credential", async () => {
    const { deps, calls } = pairDeps({ pair: fail("Keystore unavailable") });
    await expect(pairPhone(deps)).rejects.toThrow("Keystore unavailable");
    expect(calls.slice(-2)).toEqual(["forget 4", "revoke phone-1 4"]);
  });

  it("undoes the pairing when phones can't be turned on, so none is left half paired", async () => {
    const { deps, calls } = pairDeps({ setServerPhoneMode: fail("offline") });
    await expect(pairPhone(deps)).rejects.toThrow("offline");
    expect(calls).toEqual([
      "register phone-1 Pixel fcm-token",
      "registered",
      "pair s3cret 4 fallback",
      "forget 4",
      "revoke phone-1 4",
    ]);
  });

  it("doesn't start while a sign-out runs", async () => {
    const { deps, calls } = pairDeps({ stillSignedIn: () => false });
    expect(await pairPhone(deps)).toEqual({ ok: false, problem: "signed-out" });
    expect(calls).toEqual([]);
  });

  it("only revokes on the server when you signed out while it registered", async () => {
    let checks = 0;
    const { deps, calls } = pairDeps({ stillSignedIn: () => ++checks === 1 });
    expect(await pairPhone(deps)).toEqual({ ok: false, problem: "signed-out" });
    expect(calls).toEqual(["register phone-1 Pixel fcm-token", "registered", "revoke phone-1 4"]);
  });

  it("forgets its own credential again when you signed out while it was stored", async () => {
    let checks = 0;
    const { deps, calls } = pairDeps({ stillSignedIn: () => ++checks <= 2 });
    expect(await pairPhone(deps)).toEqual({ ok: false, problem: "signed-out" });
    expect(calls.slice(-2)).toEqual(["forget 4", "revoke phone-1 4"]);
  });
});

describe("turning it off for this phone", () => {
  it("stops the service first, then revokes this pairing's generation", async () => {
    const calls: string[] = [];
    const result = await turnOffThisPhone({
      status: () => ({ generation: 2 }),
      deviceId: () => "phone-1",
      forget: async () => void calls.push("forget"),
      revokeOrRemember: async (input) => {
        calls.push(`revoke ${input.deviceId} ${input.generation}`);
        return "remembered";
      },
    });
    expect(calls).toEqual(["forget", "revoke phone-1 2"]);
    expect(result).toBe("remembered");
  });
});

describe("a pairing removed elsewhere", () => {
  it("counts only when a list asked for after the pairing leaves it out", () => {
    expect(removedOnServer({ list: [], startedAt: 2_000 }, "phone-1", true, 1_000)).toBe(true);
    expect(
      removedOnServer({ list: [{ id: "phone-1" }], startedAt: 2_000 }, "phone-1", true, 1_000),
    ).toBe(false);
  });

  it("ignores a list asked for before the pairing, however late it arrives", () => {
    expect(removedOnServer({ list: [], startedAt: 500 }, "phone-1", true, 1_000)).toBe(false);
  });

  it("trusts any list for a pairing made before the app started", () => {
    expect(removedOnServer({ list: [], startedAt: 500 }, "phone-1", true, 0)).toBe(true);
  });

  it("ignores no list at all, or a phone that isn't paired", () => {
    expect(removedOnServer(undefined, "phone-1", true, 0)).toBe(false);
    expect(removedOnServer({ list: [], startedAt: 2_000 }, "phone-1", false, 0)).toBe(false);
  });
});

describe("the battery notice", () => {
  const status = (phone: Partial<EgressStatusView["phones"][number]>) =>
    ({
      phones: [
        {
          id: "phone-1",
          name: "Pixel",
          online: false,
          waking: null,
          unavailable: null,
          unanswered: null,
          lastUsedAt: null,
          ...phone,
        },
      ],
    }) as unknown as EgressStatusView;

  it("shows when this phone missed a wake and Android may be holding it back", () => {
    expect(
      needsBatteryHelp(status({ unanswered: "2026-11-21T10:00:00Z" }), "phone-1", {
        exempt: false,
      }),
    ).toBe(true);
  });

  it("stays hidden once exempt, once connected, or for another phone", () => {
    const missed = status({ unanswered: "2026-11-21T10:00:00Z" });
    expect(needsBatteryHelp(missed, "phone-1", { exempt: true })).toBe(false);
    expect(needsBatteryHelp(missed, "phone-2", { exempt: false })).toBe(false);
    expect(
      needsBatteryHelp(status({ unanswered: "2026-11-21T10:00:00Z", online: true }), "phone-1", {
        exempt: false,
      }),
    ).toBe(false);
  });
});

describe("labels", () => {
  it("names data limits as carriers do", () => {
    expect(capLabel(2e9)).toBe("2 GB");
    expect(capLabel(0)).toBe("No limit");
    expect(capLabel(3e9)).toBe("3 GB");
  });

  it("says when a paired phone was last used", () => {
    const ago = () => "5m ago";
    expect(lastUsedLabel({ online: true, lastUsedAt: null }, ago)).toBe("Connected now");
    expect(lastUsedLabel({ online: false, lastUsedAt: "2026-11-21T10:00:00Z" }, ago)).toBe(
      "Last used 5m ago",
    );
    expect(lastUsedLabel({ online: false, lastUsedAt: null }, ago)).toBe("Never used");
  });
});
