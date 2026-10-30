import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, chown, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import {
  APPLY_GUARD_URL_PATTERNS,
  blockedApplication,
  SCREEN,
  type PageContent,
  type ScreenStatus,
} from "@open-bot/shared";
import { CdpPipe, type CdpEvent } from "./cdp";
import { devtoolsCookieStore, type CookieSync } from "./cookies";
import { Desktop } from "./desktop";
import { DesktopLease, type LeaseChange } from "./lease";
import { waitFor, type ProcessSpec, type Supervisor } from "./supervisor";
import { asUser, type SystemUser } from "./users";

/** Display numbers start here, so a screen's display never collides with anything else. */
const FIRST_DISPLAY = 10;
const FIRST_VNC_PORT = 5910;
const MAX_SLOTS = 32;

export interface ScreenDeps {
  supervisor: Supervisor;
  cookies: CookieSync;
  desktopUser: SystemUser;
  /** Whether Chromium's sandbox works here. Without it, every browser runs with `--no-sandbox`. */
  browserSandbox: boolean;
  /** Where every browser sends its traffic (botd's egress SOCKS proxy). */
  socksPort: number;
  /** A profile from before screens existed. New screens start from a copy of it. */
  legacyProfile: string;
  /** Sites the apply guard covers besides the job portals. */
  applyGuardExtraDomains?: string[];
  log: (message: string) => void;
}

/** The most of a page `readPage` returns, so one page can't flood a bot's context. */
const MAX_PAGE_TEXT = 120_000;
const MAX_PAGE_LINKS = 300;

export interface ScreenManagerOptions {
  /** Screens running at once. Starting another stops the one unused the longest. */
  maxRunning?: number;
  /** A screen nobody has used or watched for this long stops. */
  idleMs?: number;
  now?: () => number;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function runAs(
  user: SystemUser,
  command: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const [cmd, argv] = asUser(user, command, args, env);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "ignore" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

/** Whether `pid` is a Chromium that is still running, not one that exited and awaits reaping. */
async function browserRunning(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat !== null && /^\d+ \(chromium\) [^Z]/.test(stat);
}

/** `args` as one string a POSIX shell reads back as the same arguments. */
export function shellQuote(args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * One bot's screen: an X display with its own XFCE desktop, two VNC servers (watch and control),
 * and its own Chromium. The bot's desktop tools act here, and you can watch or take over just this
 * screen while the other bots keep working on theirs.
 */
export class Screen {
  readonly lease = new DesktopLease();
  readonly desktop: Desktop;
  readonly display: string;
  readonly vncPorts: { view: number; control: number };
  state: ScreenStatus["state"] = "starting";
  viewers = 0;
  lastUsedAt: number;
  private cdp: CdpPipe | null = null;
  /** Portals where the apply guard stopped a submission since a bot last asked. */
  private blocked: string[] = [];
  private readonly xauthority: string;
  private readonly dir: string;
  private readonly profile: string;
  private readonly env: Record<string, string>;
  private readonly names: Record<"xvfb" | "desktop" | "vncView" | "vncControl" | "browser", string>;

  constructor(
    readonly id: string,
    readonly slot: number,
    private readonly deps: ScreenDeps,
    now: number,
  ) {
    const { desktopUser } = deps;
    this.lastUsedAt = now;
    this.display = `:${FIRST_DISPLAY + slot}`;
    this.vncPorts = { view: FIRST_VNC_PORT + slot * 2, control: FIRST_VNC_PORT + slot * 2 + 1 };
    this.xauthority = `${desktopUser.home}/.Xauthority-${slot}`;
    this.dir = `${desktopUser.home}/screens/${id}`;
    this.profile = `${this.dir}/chromium`;
    this.env = { DISPLAY: this.display, XAUTHORITY: this.xauthority };
    const short = id.slice(0, 8);
    this.names = {
      xvfb: `${short}/xvfb`,
      desktop: `${short}/desktop`,
      vncView: `${short}/vnc-view`,
      vncControl: `${short}/vnc-control`,
      browser: `${short}/chromium`,
    };
    this.desktop = new Desktop({
      user: desktopUser,
      display: this.display,
      xauthority: this.xauthority,
      openUrl: (url) => this.openUrl(url),
    });
  }

  get browserState() {
    return this.deps.supervisor.state(this.names.browser);
  }

  status(): ScreenStatus {
    return { id: this.id, state: this.state, browser: this.browserState, lease: this.lease.holder };
  }

  private get chromiumArgs(): string[] {
    return [
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,MediaRouter",
      `--proxy-server=socks5://127.0.0.1:${this.deps.socksPort}`,
      // Resolve names only through the proxy, so lookups happen where the connection leaves.
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--start-maximized",
      `--window-size=${SCREEN.width},${SCREEN.height}`,
      `--user-data-dir=${this.profile}`,
      // On hosts that refuse user namespaces the sandboxed browser crashes on start, so it runs
      // without one. The container is then the browser's only boundary.
      ...(this.deps.browserSandbox ? [] : ["--no-sandbox"]),
    ];
  }

  private async prepare() {
    const { desktopUser } = this.deps;
    const owner = { uid: desktopUser.uid, gid: desktopUser.gid };
    for (const path of [`${desktopUser.home}/screens`, this.dir]) {
      await mkdir(path, { recursive: true });
      await chown(path, owner.uid, owner.gid);
      await chmod(path, 0o700);
    }
    const legacyCookies = `${this.deps.legacyProfile}/Default/Cookies`;
    if (!(await exists(this.profile)) && (await exists(legacyCookies))) {
      // Bring the sign-ins from the browser you used before screens existed. The cookie jar shares
      // them from here, so only the cookies are copied, not the whole profile.
      await runAs(desktopUser, "mkdir", ["-p", `${this.profile}/Default`]);
      await runAs(desktopUser, "cp", ["-a", legacyCookies, `${this.profile}/Default/Cookies`]);
    }
    // A profile lock names the container that held it, and the hostname changes on every start.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      await rm(`${this.profile}/${lock}`, { force: true });

    // A fresh X cookie each start. Only the desktop user can read it, so the bot's shell can't reach the display.
    await writeFile(this.xauthority, "");
    await chown(this.xauthority, owner.uid, owner.gid);
    await chmod(this.xauthority, 0o600);
    await runAs(desktopUser, "xauth", [
      "-f",
      this.xauthority,
      "add",
      this.display,
      ".",
      randomBytes(16).toString("hex"),
    ]);
  }

  async start(): Promise<void> {
    const { supervisor, desktopUser } = this.deps;
    this.state = "starting";
    await this.prepare();
    await this.desktop.init();

    await supervisor.start({
      name: this.names.xvfb,
      command: "Xvfb",
      args: [
        this.display,
        "-screen",
        "0",
        `${SCREEN.width}x${SCREEN.height}x24`,
        "-auth",
        this.xauthority,
        "-nolisten",
        "tcp",
        "-dpi",
        "96",
      ],
      user: desktopUser,
      restart: "always",
      ready: () => waitFor(() => this.desktop.isDisplayReady(), 15_000, "the X display"),
    });

    await supervisor.start({
      name: this.names.desktop,
      command: "dbus-launch",
      args: ["--exit-with-session", "xfce4-session"],
      user: desktopUser,
      env: {
        ...this.env,
        XDG_CURRENT_DESKTOP: "XFCE",
        XDG_SESSION_TYPE: "x11",
        // Chromium started from the desktop's menu or a link uses this screen's profile and the egress
        // proxy. /etc/chromium.d/open-bot adds these to its arguments.
        OPEN_BOT_CHROMIUM_ARGS: shellQuote(
          this.chromiumArgs.filter((arg) => !arg.startsWith("--window")),
        ),
      },
      restart: "always",
      ready: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
    });

    const vnc = (name: string, port: number, viewOnly: boolean): ProcessSpec => ({
      name,
      command: "x11vnc",
      args: [
        "-display",
        this.display,
        "-auth",
        this.xauthority,
        "-rfbport",
        String(port),
        "-localhost",
        "-forever",
        "-shared",
        "-nopw",
        "-quiet",
        "-noxdamage",
        "-cursor",
        "arrow",
        ...(viewOnly ? ["-viewonly"] : []),
      ],
      user: desktopUser,
      restart: "always",
      ready: () => waitFor(() => portOpen(port), 15_000, `${name} port`),
    });
    await supervisor.start(vnc(this.names.vncView, this.vncPorts.view, true));
    await supervisor.start(vnc(this.names.vncControl, this.vncPorts.control, false));

    await this.startBrowser();
    this.state = "running";
  }

  /**
   * A browser opened from this screen's desktop while botd's was closed holds the profile, and a new
   * launch would only hand its page to that browser, outside botd's control and the apply guard.
   * Close it first. Its tabs come back in the new one.
   */
  private async reclaimProfile(): Promise<void> {
    const lock = await readlink(`${this.profile}/SingletonLock`).catch(() => null);
    const holder = lock?.match(/^(.+)-(\d+)$/);
    if (!holder || holder[1] !== hostname()) return;
    const pid = Number(holder[2]);
    if (!(await browserRunning(pid))) return;
    this.deps.log(`[screens] ${this.id.slice(0, 8)}: closing the browser opened from the desktop`);
    process.kill(pid, "SIGTERM");
    await waitFor(
      async () => !(await browserRunning(pid)),
      10_000,
      "the desktop's browser to close",
    ).catch(() => process.kill(pid, "SIGKILL"));
  }

  private async startBrowser(url?: string): Promise<void> {
    const { supervisor, desktopUser, cookies } = this.deps;
    await this.reclaimProfile();
    let cdp: CdpPipe | null = null;
    await supervisor.start({
      name: this.names.browser,
      command: "chromium",
      args: [...this.chromiumArgs, "--remote-debugging-pipe", ...(url ? [url] : [])],
      user: desktopUser,
      env: this.env,
      // You can close the browser. It opens again the next time a bot opens a page.
      restart: "never",
      // Chromium logs a stream of harmless D-Bus errors in a container.
      quiet: true,
      debugPipe: true,
      onSpawn: (child) => {
        this.cdp?.close();
        cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
        this.cdp = cdp;
        const pipe = cdp;
        pipe.on("close", () => {
          if (this.cdp === pipe) {
            this.cdp = null;
            cookies.detach(this.id);
          }
        });
      },
      ready: async () => {
        await waitFor(
          async () => Boolean(await cdp?.send("Browser.getVersion", {}, 2_000)),
          20_000,
          "the browser",
        );
        const pipe = cdp!;
        await this.guardApplications(pipe);
        await cookies.attach(
          this.id,
          devtoolsCookieStore((method, params) => pipe.send(method, params)),
        );
        await this.maximizeWindows(pipe).catch(() => {});
      },
    });
  }

  /**
   * Fill the screen. A browser that opens again restores its windows' last bounds instead of
   * honoring --start-maximized, which leaves the desktop showing around it.
   */
  private async maximizeWindows(pipe: CdpPipe) {
    const { targetInfos } = await pipe.send<{ targetInfos: { targetId: string; type: string }[] }>(
      "Target.getTargets",
      {},
    );
    const windows = new Set<number>();
    for (const { targetId, type } of targetInfos) {
      if (type !== "page") continue;
      const { windowId } = await pipe.send<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId,
      });
      windows.add(windowId);
    }
    for (const windowId of windows) {
      await pipe.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "maximized" },
      });
    }
  }

  /**
   * The apply guard: a bot's browser can't submit a job application. Requests whose address mentions
   * "apply" pause here, browser-wide (every tab and frame), and the ones that would submit to a job
   * portal fail unless you hold the screen.
   */
  private async guardApplications(pipe: CdpPipe) {
    pipe.on("event", (event) => void this.onBrowserEvent(pipe, event));
    await pipe.send("Fetch.enable", {
      patterns: APPLY_GUARD_URL_PATTERNS.map((urlPattern) => ({
        urlPattern,
        requestStage: "Request",
      })),
    });
  }

  private async onBrowserEvent(pipe: CdpPipe, event: CdpEvent) {
    if (event.method !== "Fetch.requestPaused") return;
    const { requestId, request } = event.params as {
      requestId: string;
      request: { url: string; method: string };
    };
    const site = blockedApplication(request.url, request.method, this.deps.applyGuardExtraDomains);
    const blocked = site !== null && this.lease.holder?.kind !== "user";
    try {
      if (blocked) {
        this.blocked.push(site.label);
        this.deps.log(
          `[guard] blocked ${request.method} ${new URL(request.url).origin} on screen ${this.id}`,
        );
        await pipe.send(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          10_000,
          event.sessionId,
        );
      } else {
        await pipe.send("Fetch.continueRequest", { requestId }, 10_000, event.sessionId);
      }
    } catch {
      // The tab may have closed meanwhile; its request went with it.
    }
  }

  /** Portals the guard stopped a submission on since the last call, and forget them. */
  takeBlocked(): string[] {
    const blocked = this.blocked;
    this.blocked = [];
    return blocked;
  }

  /** Open a page in a new tab, starting the browser if you closed it. */
  async openUrl(url: string): Promise<void> {
    if (this.browserState !== "running" || !this.cdp?.isOpen) {
      await this.startBrowser(url);
      return;
    }
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  }

  /**
   * The addresses of the tabs showing in the browser: the one in front in each window. Empty when
   * the browser is closed.
   */
  async visiblePages(): Promise<string[]> {
    const cdp = this.cdp;
    if (this.browserState !== "running" || !cdp?.isOpen) return [];
    const { targetInfos } = await cdp.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>("Target.getTargets");
    const visible: string[] = [];
    for (const page of targetInfos.filter((target) => target.type === "page")) {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      try {
        const { result } = await cdp.send<{ result: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true },
          3_000,
          sessionId,
        );
        if (result.value === "visible") visible.push(page.url);
      } catch {
        // A page that doesn't answer isn't one you can fill anything in.
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    return visible;
  }

  /**
   * The readable content of the tab in front: its address, title, visible text and links. With a
   * selector, only that part of the page.
   */
  async readPage(selector?: string): Promise<PageContent | { error: string }> {
    const cdp = this.cdp;
    if (this.browserState !== "running" || !cdp?.isOpen)
      return { error: "The browser isn't open." };
    const { targetInfos } = await cdp.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>("Target.getTargets");
    for (const page of targetInfos.filter((target) => target.type === "page")) {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      try {
        const { result } = await cdp.send<{ result: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: readPageScript(selector), returnByValue: true },
          10_000,
          sessionId,
        );
        const value = result.value as
          (PageContent & { visible: boolean; missing?: boolean }) | undefined;
        if (!value?.visible) continue;
        if (value.missing)
          return {
            error: `Nothing on the page matches ${selector}, or it isn't a valid CSS selector.`,
          };
        const truncated = value.text.length > MAX_PAGE_TEXT;
        return {
          url: value.url,
          title: value.title,
          text: truncated ? value.text.slice(0, MAX_PAGE_TEXT) : value.text,
          truncated,
          links: value.links.slice(0, MAX_PAGE_LINKS),
        };
      } catch {
        // A page that doesn't answer isn't the one in front.
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    return { error: "No page is showing in the browser." };
  }

  /** Delete the screen's browser profile. Sign-ins stay in the shared cookie jar. */
  async forget(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    const { supervisor, cookies } = this.deps;
    cookies.detach(this.id);
    this.desktop.abortAll();
    // The browser first, so it saves its tabs, then everything that draws on the display.
    await supervisor.stop(this.names.browser);
    for (const name of [
      this.names.vncView,
      this.names.vncControl,
      this.names.desktop,
      this.names.xvfb,
    ])
      await supervisor.stop(name);
    await rm(this.xauthority, { force: true });
  }
}

/**
 * The bots' screens on the shared computer, keyed by bot id. A screen starts the first time its bot
 * or you use it, and stops after a while unused; its browser profile stays on disk.
 */
export class ScreenManager extends EventEmitter<{
  lease: [string, LeaseChange];
  changed: [];
}> {
  private readonly screens = new Map<string, Screen>();
  private readonly starting = new Map<string, Promise<Screen>>();
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: ScreenDeps,
    options: ScreenManagerOptions = {},
  ) {
    super();
    this.maxRunning = options.maxRunning ?? 4;
    this.idleMs = options.idleMs ?? 20 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get(id: string): Screen | undefined {
    const screen = this.screens.get(id);
    return screen?.state === "running" ? screen : undefined;
  }

  list(): ScreenStatus[] {
    return [...this.screens.values()].map((screen) => screen.status());
  }

  touch(screen: Screen): void {
    screen.lastUsedAt = this.now();
  }

  /** The bot's screen, started if it isn't running. */
  ensure(id: string): Promise<Screen> {
    const running = this.get(id);
    if (running) {
      this.touch(running);
      return Promise.resolve(running);
    }
    let pending = this.starting.get(id);
    if (!pending) {
      pending = this.startScreen(id).finally(() => this.starting.delete(id));
      this.starting.set(id, pending);
    }
    return pending;
  }

  private freeSlot(): number {
    const used = new Set([...this.screens.values()].map((screen) => screen.slot));
    for (let slot = 0; slot < MAX_SLOTS; slot += 1) if (!used.has(slot)) return slot;
    throw new Error("Too many screens are running");
  }

  private async startScreen(id: string): Promise<Screen> {
    const previous = this.screens.get(id);
    if (previous) await this.stopScreen(previous);
    await this.makeRoom();

    const screen = new Screen(id, this.freeSlot(), this.deps, this.now());
    this.screens.set(id, screen);
    screen.lease.on("change", (change) => {
      this.touch(screen);
      this.emit("lease", id, change);
    });
    // Taking over stops whatever the bot was doing on this screen right away.
    screen.lease.on("preempted", () => screen.desktop.abortAll());
    this.emit("changed");
    this.deps.log(`[screens] starting ${id} on ${screen.display}`);
    try {
      await screen.start();
    } catch (error) {
      this.deps.log(`[screens] ${id} failed to start: ${String(error)}`);
      await this.stopScreen(screen);
      throw error;
    }
    this.touch(screen);
    this.emit("changed");
    return screen;
  }

  /**
   * Stop the screen unused the longest when too many are running, preferring ones nobody is
   * watching. Screens a bot or you hold are never stopped.
   */
  private async makeRoom() {
    const running = [...this.screens.values()].filter((screen) => screen.state === "running");
    if (running.length < this.maxRunning) return;
    const idle = running
      .filter((screen) => screen.lease.holder === null)
      .sort((a, b) => Number(a.viewers > 0) - Number(b.viewers > 0) || a.lastUsedAt - b.lastUsedAt);
    for (const screen of idle.slice(0, running.length - this.maxRunning + 1)) {
      this.deps.log(`[screens] stopping ${screen.id} to make room`);
      await this.stopScreen(screen);
    }
  }

  private async stopScreen(screen: Screen) {
    if (this.screens.get(screen.id) !== screen) return;
    await screen
      .stop()
      .catch((error: unknown) =>
        this.deps.log(`[screens] stopping ${screen.id} failed: ${String(error)}`),
      );
    this.screens.delete(screen.id);
    this.emit("changed");
  }

  /** The bot is gone: stop its screen and delete its browser profile. */
  async forget(id: string): Promise<void> {
    await this.starting.get(id)?.catch(() => {});
    const screen = this.screens.get(id) ?? new Screen(id, -1, this.deps, this.now());
    if (this.screens.get(id) === screen) await this.stopScreen(screen);
    await screen.forget();
  }

  releaseRun(runId: string): boolean {
    let released = false;
    for (const screen of this.screens.values())
      released = screen.lease.releaseRun(runId) || released;
    return released;
  }

  /** Time out leases, and stop screens nobody has used for a while. Watching alone doesn't count as use. */
  sweep(): void {
    const now = this.now();
    for (const screen of [...this.screens.values()]) {
      screen.lease.sweep();
      if (
        screen.state === "running" &&
        screen.lease.holder === null &&
        now - screen.lastUsedAt >= this.idleMs
      ) {
        this.deps.log(
          `[screens] stopping ${screen.id} after ${Math.round(this.idleMs / 60_000)} idle minutes`,
        );
        void this.stopScreen(screen);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.screens.values()].map((screen) => this.stopScreen(screen)));
  }
}

/** Runs in the page: what a person sees on it, as text, and its links. */
function readPageScript(selector?: string): string {
  return `(() => {
    if (document.visibilityState !== "visible") return { visible: false };
    let root;
    try {
      root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
    } catch {
      root = null;
    }
    if (!root) return { visible: true, missing: true };
    const seen = new Set();
    const links = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: (a.innerText || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 200), href });
    }
    const text = (root.innerText || "").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
    return { visible: true, url: location.href, title: document.title, text, links };
  })()`;
}
