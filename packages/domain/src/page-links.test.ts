import { describe, expect, it } from "vitest";
import {
  PAGE_LINK_TTL_SECONDS,
  pageVersionUrl,
  signPageVersion,
  verifyPageVersion,
} from "./page-links";

const secret = "a-secret-that-is-long-enough-0123456789";
const id = "2b148551-94eb-4df1-90ef-231f7386f89a";
/** In milliseconds, like Date.now(). */
const now = 1_800_000_000_000;
const seconds = now / 1000;

describe("page links", () => {
  it("opens the version it was signed for, until it expires", () => {
    const key = signPageVersion(id, secret, PAGE_LINK_TTL_SECONDS, now);
    expect(verifyPageVersion(id, key, secret, now)).toBe(true);
    expect(verifyPageVersion(id, key, secret, now + (PAGE_LINK_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyPageVersion(id, key, secret, now + PAGE_LINK_TTL_SECONDS * 1000)).toBe(false);
  });

  it("refuses another version, another secret, or a changed expiry", () => {
    const key = signPageVersion(id, secret, 600, now);
    expect(verifyPageVersion("3637f7d1-3434-4882-a05b-3c14f29c2001", key, secret, now)).toBe(false);
    expect(verifyPageVersion(id, key, `${secret}x`, now)).toBe(false);
    const [, signature] = key.split(".");
    expect(verifyPageVersion(id, `${seconds + 99_999}.${signature}`, secret, now)).toBe(false);
  });

  it("refuses keys that aren't keys", () => {
    for (const key of [
      "",
      ".",
      "abc",
      `${seconds + 60}`,
      `${seconds + 60}.`,
      `x.${"a".repeat(43)}`,
      `${seconds + 60}.${"a".repeat(10)}`,
    ])
      expect(verifyPageVersion(id, key, secret, now)).toBe(false);
  });

  it("builds the address on the pages origin, keeping the view options", () => {
    const url = new URL(
      pageVersionUrl("https://pages.example.app/", id, secret, "theme=dark&ask=1"),
    );
    expect(url.origin).toBe("https://pages.example.app");
    expect(url.pathname).toBe(`/v/${id}`);
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("ask")).toBe("1");
    expect(verifyPageVersion(id, url.searchParams.get("k")!, secret)).toBe(true);
  });
});
