import { describe, expect, it } from "vitest";
import { safeNext, signInPath } from "./sign-in-return";

describe("safeNext", () => {
  it.each([
    "/",
    "/chats/3f2a",
    "/chats/abc?tab=files",
    "/settings#security",
    "/files?path=Projects%2Fnotes.md",
    "/search?q=100%25",
    "/automations?view=list&sort=new",
    "/loginish",
    "/apis",
  ])("keeps the app's own page %s", (value) => {
    expect(safeNext(value)).toBe(value);
  });

  it.each([
    // Another origin, in every spelling a browser accepts.
    "//evil.com",
    "//evil.com/chats",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "http:evil.com",
    "HTTPS://evil.com/",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    // Paths that normalizing (resolving dot segments) turns into another host's.
    "/.//evil.com/",
    "/a/..//evil.com/",
    "/%2e//evil.com",
    "/a/%2E%2E//evil.com",
    "/./%2F/evil.com",
    "/chats/../..//evil.com",
    // Encoded so a later decode turns it into one.
    "%2F%2Fevil.com",
    "/%2F/evil.com",
    "/%2Fevil.com",
    "/%5Cevil.com",
    "/%252F%252Fevil.com",
    "%2Fchats",
    // Control characters, raw or encoded: header splitting, and browsers drop tabs and newlines.
    "/chats\n//evil.com",
    "/chats%0A",
    "/chats%0d%0aSet-Cookie:x=y",
    "/\t/evil.com",
    "/%09/evil.com",
    "/chats%00",
    "/chats%250A",
    // Sign-in itself, first-time setup and the API: not pages to come back to.
    "/login",
    "/login?next=/chats",
    "/login/",
    "/setup",
    "/api/rpc/app/state",
    "/api",
    "/%61pi/rpc",
    "/./login",
    "/chats/../login",
    "/LOGIN",
    // Not a path at all.
    "",
    "chats",
    " /chats",
    "?next=/",
    "#x",
    `/${"a".repeat(3000)}`,
  ])("goes home instead of %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it("goes home when there is no value", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });

  it("answers the path as the browser will read it", () => {
    expect(safeNext("/chats/./3f2a")).toBe("/chats/3f2a");
    expect(safeNext("/chats/x/../3f2a")).toBe("/chats/3f2a");
  });
});

describe("signInPath", () => {
  it("carries the page in next", () => {
    expect(signInPath("/chats/abc?tab=files")).toBe("/login?next=%2Fchats%2Fabc%3Ftab%3Dfiles");
    expect(signInPath("/chats/1", "/setup")).toBe("/setup?next=%2Fchats%2F1");
  });

  it("keeps the plain page for home or anything refused", () => {
    expect(signInPath("/")).toBe("/login");
    expect(signInPath(null)).toBe("/login");
    expect(signInPath("//evil.com")).toBe("/login");
    expect(signInPath("/login?next=/chats", "/setup")).toBe("/setup");
  });

  it("reads back to the same page", () => {
    const page = "/files?path=a%20b&x=1#top";
    const url = new URL(signInPath(page), "http://localhost");
    expect(safeNext(url.searchParams.get("next"))).toBe(page);
  });
});
