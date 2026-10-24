import { describe, expect, it } from "vitest";
import { CookieSync, type Cookie, type CookieStore } from "./cookies";

const NOW = 1_800_000_000_000;

function cookie(name: string, value: string, extra: Partial<Cookie> = {}): Cookie {
  return {
    name,
    value,
    domain: ".example.com",
    path: "/",
    expires: NOW / 1000 + 3600,
    httpOnly: true,
    secure: true,
    session: false,
    ...extra,
  };
}

/** A browser's cookie store: setting an expired cookie deletes it, like Chromium. */
class FakeBrowser implements CookieStore {
  readonly cookies = new Map<string, Cookie>();
  refuse = new Set<string>();

  constructor(initial: Cookie[] = []) {
    for (const c of initial) this.put(c);
  }

  put(c: Cookie) {
    this.cookies.set(`${c.name}|${c.domain}|${c.path}`, c);
  }

  remove(name: string) {
    for (const [key, c] of this.cookies) if (c.name === name) this.cookies.delete(key);
  }

  value(name: string): string | undefined {
    return [...this.cookies.values()].find((c) => c.name === name)?.value;
  }

  async getCookies() {
    return [...this.cookies.values()].map((c) => ({ ...c }));
  }

  async setCookies(cookies: Cookie[]) {
    for (const c of cookies) {
      if (this.refuse.has(c.name)) continue;
      if (!c.session && c.expires <= NOW / 1000) this.remove(c.name);
      else this.put({ ...c });
    }
  }
}

function setup() {
  return new CookieSync(
    null,
    () => {},
    () => NOW,
  );
}

describe("CookieSync", () => {
  it("gives a new browser every sign-in, and collects the ones only it has", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("github", "a1")]);
    const b = new FakeBrowser([cookie("google", "b1")]);
    await sync.attach("a", a);
    await sync.attach("b", b);
    expect(b.value("github")).toBe("a1");
    expect(a.value("google")).toBe("b1");
    expect(sync.size).toBe(2);
  });

  it("copies a sign-in made in one browser to the others", async () => {
    const sync = setup();
    const a = new FakeBrowser();
    const b = new FakeBrowser();
    const c = new FakeBrowser();
    for (const [id, browser] of [
      ["a", a],
      ["b", b],
      ["c", c],
    ] as const)
      await sync.attach(id, browser);
    a.put(cookie("session", "fresh"));
    await sync.sync();
    expect(b.value("session")).toBe("fresh");
    expect(c.value("session")).toBe("fresh");
  });

  it("copies a refreshed session without echoing it back", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("sid", "v1")]);
    const b = new FakeBrowser();
    await sync.attach("a", a);
    await sync.attach("b", b);
    b.put(cookie("sid", "v2"));
    await sync.sync();
    expect(a.value("sid")).toBe("v2");
    await sync.sync();
    expect(a.value("sid")).toBe("v2");
    expect(b.value("sid")).toBe("v2");
  });

  it("signs out everywhere when a cookie is removed in one browser", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("sid", "v1")]);
    const b = new FakeBrowser();
    await sync.attach("a", a);
    await sync.attach("b", b);
    a.remove("sid");
    await sync.sync();
    expect(b.value("sid")).toBeUndefined();
    expect(sync.size).toBe(0);
  });

  it("doesn't let a stale copy delete a newer sign-in", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("sid", "v1")]);
    const b = new FakeBrowser();
    await sync.attach("a", a);
    await sync.attach("b", b);
    // B signs in again, and before the next sync A drops its old copy.
    b.put(cookie("sid", "v2"));
    a.remove("sid");
    await sync.sync();
    expect(b.value("sid")).toBe("v2");
    expect(a.value("sid")).toBe("v2");
  });

  it("doesn't treat a cookie a browser refused as a sign-out", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("odd", "x"), cookie("sid", "v1")]);
    const b = new FakeBrowser();
    b.refuse.add("odd");
    await sync.attach("a", a);
    await sync.attach("b", b);
    await sync.sync();
    await sync.sync();
    expect(a.value("odd")).toBe("x");
    expect(b.value("sid")).toBe("v1");
  });

  it("keeps session cookies across a browser restart", async () => {
    const sync = setup();
    const a = new FakeBrowser([cookie("login", "s", { session: true, expires: -1 })]);
    await sync.attach("a", a);
    sync.detach("a");
    const restarted = new FakeBrowser();
    await sync.attach("a", restarted);
    expect(restarted.value("login")).toBe("s");
  });
});
