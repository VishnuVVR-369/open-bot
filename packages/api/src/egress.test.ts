import { describe, expect, it } from "vitest";
import { describeEgress, OFFLINE_EGRESS_STATUS, type EgressStatusView } from "./egress";

const phone = (overrides: Partial<EgressStatusView["phones"][number]> = {}) => ({
  id: "phone-1",
  name: "Pixel",
  online: false,
  waking: null,
  unavailable: null,
  unanswered: null,
  lastUsedAt: null,
  ...overrides,
});

const status = (overrides: Partial<EgressStatusView>): EgressStatusView => ({
  ...OFFLINE_EGRESS_STATUS,
  computerConnected: true,
  ...overrides,
});

describe("where the computer's browsing goes, in words", () => {
  it("names the device carrying it, with nothing more to say", () => {
    expect(describeEgress(status({ path: "desktop" }))).toEqual({
      label: "Through your Mac",
      detail: null,
    });
    expect(describeEgress(status({ path: "phone", phones: [phone({ online: true })] }))).toEqual({
      label: "Through your phone",
      detail: null,
    });
  });

  it("says why it goes direct when the phone can't help", () => {
    const unavailable = {
      reason: "wifi-only" as const,
      message: "Phone is on mobile data",
      until: "2026-11-21T10:15:00Z",
    };
    expect(describeEgress(status({ path: "direct", phones: [phone({ unavailable })] }))).toEqual({
      label: "Direct from the cloud",
      detail: "Phone is on mobile data",
    });
  });

  it("asks you to open the app when the phone didn't answer", () => {
    expect(
      describeEgress(
        status({ path: "blocked", mode: "require", phones: [phone({ unanswered: "2026-11-21" })] }),
      ),
    ).toEqual({
      label: "Browsing paused",
      detail: "Your phone didn't answer. Open open-bot on it.",
    });
  });

  it("says routing is off before anything about devices", () => {
    expect(describeEgress(status({ path: "direct", mode: "off" })).detail).toBe(
      "Routing through your devices is off.",
    );
  });

  it("says when a paired phone takes over from the cloud", () => {
    expect(describeEgress(status({ path: "direct", phones: [phone()] })).detail).toBe(
      "Your phone connects when teammates browse while your Mac is offline.",
    );
    expect(describeEgress(status({ path: "direct" })).detail).toBeNull();
  });

  it("waits for the phone while it wakes", () => {
    expect(describeEgress(status({ path: "waiting" })).label).toBe("Waiting for your phone");
  });
});
