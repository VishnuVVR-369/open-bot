import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, chown, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { SCREEN, type ScreenStatus } from "@open-bot/shared";
import { CdpPipe } from "./cdp";
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
  /** Where every browser sends its traffic (botd's egress SOCKS proxy). */
  socksPort: number;
  /** A profile from before screens existed. New screens start from a copy of it. */
  legacyProfile: string;
  log: (message: string) => void;
}

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
        // Chromium started from the desktop's menu uses this screen's profile and the egress proxy.
        CHROMIUM_FLAGS: this.chromiumArgs.filter((arg) => !arg.startsWith("--window")).join(" "),
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

  private async startBrowser(url?: string): Promise<void> {
    const { supervisor, desktopUser, cookies } = this.deps;
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
        await cookies.attach(
          this.id,
          devtoolsCookieStore((method, params) => pipe.send(method, params)),
        );
      },
    });
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
