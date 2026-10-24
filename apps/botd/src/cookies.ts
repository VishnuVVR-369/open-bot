import { chmod, readFile, rename, writeFile } from "node:fs/promises";

/** A cookie as the DevTools protocol reports it (`Network.Cookie`), with the fields we keep. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
}

/** A browser whose cookies can be read and written. */
export interface CookieStore {
  getCookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
}

const PERSIST_DELAY_MS = 1_000;

function keyOf(cookie: Cookie): string {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);
}

function fingerprint(cookie: Cookie): string {
  return JSON.stringify([
    cookie.value,
    cookie.session ? null : Math.round(cookie.expires),
    cookie.httpOnly,
    cookie.secure,
    cookie.sameSite ?? null,
  ]);
}

/** The same cookie, expired, which deletes it when set. */
function tombstone(cookie: Cookie): Cookie {
  return { ...cookie, value: "", session: false, expires: 1 };
}

function pick(cookie: Cookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    session: cookie.session,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.priority ? { priority: cookie.priority } : {}),
    ...(cookie.sourceScheme ? { sourceScheme: cookie.sourceScheme } : {}),
    ...(cookie.sourcePort !== undefined ? { sourcePort: cookie.sourcePort } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** The fields `Storage.setCookies` accepts. Session cookies have no expiry. */
export function toCookieParam(cookie: Cookie): Record<string, unknown> {
  const { session, expires, ...rest } = pick(cookie);
  return session ? rest : { ...rest, expires };
}

interface Attached {
  store: CookieStore;
  /** What this browser held at its last sync: cookie key to fingerprint. */
  seen: Map<string, string>;
}

/**
 * Keeps every screen's browser signed in to the same sites.
 *
 * Each screen runs its own Chromium with its own profile, because two Chromium processes can't
 * share one. This merges their cookies into one jar: a cookie that changes in one browser (you
 * signed in, a session was refreshed, you signed out) is copied to the others within seconds.
 * The jar is saved, so a screen that starts later begins with every sign-in.
 */
export class CookieSync {
  private readonly jar = new Map<string, Cookie>();
  private readonly browsers = new Map<string, Attached>();
  private queue: Promise<void> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.jar.size;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const cookies = JSON.parse(await readFile(this.file, "utf8")) as Cookie[];
      const now = this.now() / 1000;
      for (const cookie of cookies)
        if (cookie.session || cookie.expires > now) this.jar.set(keyOf(cookie), cookie);
    } catch {
      // No jar yet.
    }
  }

  /** Run one sync step at a time, in order. */
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.catch((error: unknown) => this.log(`[cookies] ${String(error)}`));
    return this.queue;
  }

  /** A browser started: it gets every cookie in the jar, and the jar gets the ones only it has. */
  attach(id: string, store: CookieStore): Promise<void> {
    return this.serial(async () => {
      const own = new Map((await store.getCookies()).map((c) => [keyOf(c), pick(c)]));
      const added: Cookie[] = [];
      for (const [key, cookie] of own) {
        if (!this.jar.has(key)) {
          this.jar.set(key, cookie);
          added.push(cookie);
        }
      }
      const missing = [...this.jar.entries()]
        .filter(([key, cookie]) => {
          const mine = own.get(key);
          return !mine || fingerprint(mine) !== fingerprint(cookie);
        })
        .map(([, cookie]) => cookie);
      if (missing.length) await store.setCookies(missing);
      // Remember what the browser actually holds, so cookies it refused don't look like sign-outs later.
      const now = missing.length ? await store.getCookies() : [...own.values()];
      this.browsers.set(id, {
        store,
        seen: new Map(now.map((cookie) => [keyOf(cookie), fingerprint(pick(cookie))])),
      });
      if (added.length) {
        await this.broadcast(id, added);
        this.schedulePersist();
      }
    });
  }

  detach(id: string): void {
    this.browsers.delete(id);
  }

  /**
   * Copy what changed in any browser since the last sync to the others.
   * Every browser is read first, so a sign-in anywhere wins over a stale copy disappearing elsewhere.
   */
  sync(): Promise<void> {
    return this.serial(async () => {
      const reads: { id: string; browser: Attached; current: Map<string, Cookie> }[] = [];
      for (const [id, browser] of [...this.browsers]) {
        try {
          const cookies = await browser.store.getCookies();
          reads.push({ id, browser, current: new Map(cookies.map((c) => [keyOf(c), pick(c)])) });
        } catch {
          // The browser is closing. It is detached when it exits.
        }
      }

      const changed = new Set<string>();
      for (const { browser, current } of reads) {
        for (const [key, cookie] of current) {
          const print = fingerprint(cookie);
          if (browser.seen.get(key) === print) continue;
          const known = this.jar.get(key);
          if (!known || fingerprint(known) !== print) {
            this.jar.set(key, cookie);
            changed.add(key);
          }
        }
      }
      const removed = new Map<string, Cookie>();
      for (const { browser, current } of reads) {
        for (const [key, print] of browser.seen) {
          if (current.has(key) || changed.has(key)) continue;
          // Gone from this browser: signed out, deleted or expired. Only follow it if the jar still
          // holds what this browser last had, so an older copy can't delete a newer sign-in.
          const known = this.jar.get(key);
          if (known && fingerprint(known) === print) {
            this.jar.delete(key);
            removed.set(key, tombstone(known));
          }
        }
      }

      for (const { id, browser, current } of reads) {
        browser.seen = new Map([...current].map(([key, cookie]) => [key, fingerprint(cookie)]));
        if (this.browsers.get(id) !== browser) continue;
        // Each browser gets only what it doesn't already have. Its `seen` map stays as read: its next
        // sync finds the new values already in the jar, so nothing echoes back, and a cookie it
        // refuses isn't mistaken for a sign-out.
        const updates: Cookie[] = [];
        for (const key of changed) {
          const cookie = this.jar.get(key)!;
          const mine = current.get(key);
          if (!mine || fingerprint(mine) !== fingerprint(cookie)) updates.push(cookie);
        }
        for (const [key, cookie] of removed) if (current.has(key)) updates.push(cookie);
        if (updates.length) await this.write(browser, updates);
      }
      if (changed.size || removed.size) this.schedulePersist();
    });
  }

  private async broadcast(fromId: string, changes: Cookie[]) {
    for (const [id, browser] of this.browsers)
      if (id !== fromId) await this.write(browser, changes);
  }

  private async write(browser: Attached, cookies: Cookie[]) {
    await browser.store
      .setCookies(cookies)
      .catch((error: unknown) =>
        this.log(`[cookies] could not update a browser: ${String(error)}`),
      );
  }

  private schedulePersist() {
    if (!this.file || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch((error: unknown) =>
        this.log(`[cookies] could not save the jar: ${String(error)}`),
      );
    }, PERSIST_DELAY_MS);
  }

  async persist(): Promise<void> {
    if (!this.file) return;
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify([...this.jar.values()]), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }
}

/** A CookieStore backed by a browser's DevTools connection. */
export function devtoolsCookieStore(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
): CookieStore {
  return {
    async getCookies() {
      const { cookies } = await send<{ cookies: Cookie[] }>("Storage.getCookies");
      return cookies;
    },
    async setCookies(cookies) {
      const params = cookies.map(toCookieParam);
      try {
        await send("Storage.setCookies", { cookies: params });
      } catch {
        // One cookie the browser rejects fails the whole batch, so fall back to one at a time.
        for (const cookie of params)
          await send("Storage.setCookies", { cookies: [cookie] }).catch(() => {});
      }
    },
  };
}
