import { describe, expect, it } from "vitest";
import { passkeyLabel, passkeyNameFor } from "./passkey-name";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
};

describe("passkeyNameFor", () => {
  it("names the browser and the device", () => {
    expect(passkeyNameFor(UA.chromeMac)).toBe("Chrome on Mac");
    expect(passkeyNameFor(UA.safariMac)).toBe("Safari on Mac");
    expect(passkeyNameFor(UA.safariIphone)).toBe("Safari on iPhone");
    expect(passkeyNameFor(UA.edgeWindows)).toBe("Edge on Windows");
    expect(passkeyNameFor(UA.firefoxLinux)).toBe("Firefox on Linux");
    expect(passkeyNameFor(UA.chromeAndroid)).toBe("Chrome on Android");
  });

  it("falls back when it can't tell", () => {
    expect(passkeyNameFor("")).toBe("This device");
  });
});

describe("passkeyLabel", () => {
  it("reads raw platform names as the device", () => {
    expect(passkeyLabel("MacIntel")).toBe("Mac");
    expect(passkeyLabel("Win32")).toBe("Windows");
    expect(passkeyLabel("Linux x86_64")).toBe("Linux");
    expect(passkeyLabel("Linux armv8l")).toBe("Android");
    expect(passkeyLabel("iPhone")).toBe("iPhone");
  });

  it("keeps real names", () => {
    expect(passkeyLabel("Chrome on Mac")).toBe("Chrome on Mac");
    expect(passkeyLabel("Work laptop")).toBe("Work laptop");
    expect(passkeyLabel("Mac mini at home")).toBe("Mac mini at home");
  });

  it("names an unnamed passkey", () => {
    expect(passkeyLabel("")).toBe("Passkey");
    expect(passkeyLabel(null)).toBe("Passkey");
  });
});
