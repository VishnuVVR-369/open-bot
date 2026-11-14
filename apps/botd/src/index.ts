import { access, chmod, chown, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { COMPUTER_PATHS, isOwnerLease, type ComputerHealth } from "@open-bot/domain";
import { backgroundProcess, type ProcessView } from "./background";
import { ComputeLifecycle } from "./lifecycle";
import { CodeScreens } from "./code-screens";
import { CookieSync } from "./cookies";
import { readEnv, type BotdEnv } from "./env";
import { EgressRouter } from "@open-bot/egress/router";
import { PageChecker, PagePreviewServer } from "./pages";
import { browserSandboxAvailable } from "./sandbox";
import { ScreenManager } from "./screens";
import { createServer } from "./server";
import { Supervisor, waitFor } from "./supervisor";
import { lookupUser, runAs } from "./users";

const PORTS = { botd: 7000, codex: 4500, socks: 1080 } as const;
/** botd's own state, which no teammate can read: the shared cookie jar. */
const STATE_DIR = "/home/.botd";
/** The dock's pins and look, named for its plugin id in xfce4-panel.xml. */
const DOCK_PINS = "docklike-5.rc";

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

let env: BotdEnv;
try {
  env = readEnv();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const { token, lifecycleEnabled } = env;

const desktopUser = lookupUser("desktop");
const botUser = lookupUser("bot");
const bootedAt = new Date().toISOString();

async function ensureDir(path: string, owner: { uid: number; gid: number }, mode: number) {
  await mkdir(path, { recursive: true });
  await chown(path, owner.uid, owner.gid);
  await chmod(path, mode);
}

const CODEX_CONFIG = `# Managed by botd. Edits are overwritten on start.
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
sandbox_mode = "danger-full-access"
approval_policy = "never"

[features]
memories = false

[notice]
hide_full_access_warning = true
`;

async function prepareFilesystem() {
  const botGroup = { uid: botUser.uid, gid: botUser.gid };
  // The shared folders are group-writable by both users (the `bots` group), and new files inherit the group.
  const shared = { uid: botUser.uid, gid: env.sharedGid ?? botUser.gid };
  await ensureDir(botUser.home, botGroup, 0o755);
  await ensureDir(COMPUTER_PATHS.teammatesRoot, botGroup, 0o755);
  await ensureDir(COMPUTER_PATHS.shared, shared, 0o2775);
  await ensureDir(COMPUTER_PATHS.downloads, shared, 0o2775);
  await ensureDir(COMPUTER_PATHS.codexHome, botGroup, 0o700);
  await writeFile(`${COMPUTER_PATHS.codexHome}/config.toml`, CODEX_CONFIG);
  await chown(`${COMPUTER_PATHS.codexHome}/config.toml`, botUser.uid, botUser.gid);
  await ensureDir(desktopUser.home, { uid: desktopUser.uid, gid: desktopUser.gid }, 0o750);
  await ensureDir(STATE_DIR, { uid: 0, gid: 0 }, 0o700);
  await seedDock();
}

/**
 * The dock on every screen reads its pinned apps only from the user's own config, not the image's
 * defaults, so copy them there. Pins you change in the dock stay.
 */
async function seedDock() {
  const pins = `${desktopUser.home}/.config/xfce4/panel/${DOCK_PINS}`;
  const seeded = await access(pins).then(
    () => true,
    () => false,
  );
  if (seeded) return;
  const defaults = `/etc/xdg/xfce4/panel/${DOCK_PINS}`;
  await runAs(desktopUser, "install", ["-D", "-m", "644", defaults, pins]);
}

const browserSandbox = await browserSandboxAvailable(desktopUser);
if (!browserSandbox) {
  log(
    "WARNING: this host refuses the user namespaces Chromium's sandbox needs, so browsers run with --no-sandbox",
  );
}

const supervisor = new Supervisor(log);
let broadcastHealth = () => {};
const egress = new EgressRouter({
  log,
  onChange: () => broadcastHealth(),
  stateFile: `${STATE_DIR}/egress.json`,
  leasedScreens: () =>
    screens
      .list()
      .filter((screen) => screen.state !== "paused" && screen.lease !== null)
      .map((screen) => screen.id),
});
const cookies = new CookieSync(`${STATE_DIR}/cookies.json`, log);
const codeScreens = new CodeScreens(`${STATE_DIR}/code-screens`);
const screens: ScreenManager = new ScreenManager(
  {
    supervisor,
    workActive: () => lifecycleEnabled && lifecycle.hasWork,
    cookies,
    codeScreens,
    desktopUser,
    browserSandbox,
    socksPort: PORTS.socks,
    legacyProfile: `${desktopUser.home}/.config/chromium`,
    applyGuardExtraDomains: env.applyGuardExtraDomains,
    log,
  },
  {
    maxRunning: env.maxScreens,
    idleMs: env.screenIdleMs,
  },
);

/** Drafts of pages, as teammates (and their browsers) see them, and the checker that renders them. */
const pagePreview = new PagePreviewServer(env.pageLibDir, log);
const pageChecker = new PageChecker(pagePreview, desktopUser, browserSandbox, log);

// Every live process of the bot user. Failure to inspect /proc blocks sleep.
async function botProcesses(uid = botUser.uid): Promise<Set<string>> {
  const pids = new Set<string>();
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return "";
        throw error;
      },
    );
    if (new RegExp(`^Uid:\\s+${uid}\\s`, "m").test(status) && !/^State:\s+Z/m.test(status))
      pids.add(pid);
  }
  return pids;
}
async function hasBackgroundProcesses(): Promise<boolean> {
  const views = await Promise.all(
    [...(await botProcesses())].map(async (pid): Promise<ProcessView | null> => {
      const [status, command] = await Promise.all([
        readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
        readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      ]);
      if (!status) return null; // It exited while enumerating.
      const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
      return { pid: Number(pid), parent, args: command.split("\0") };
    }),
  );
  const work = backgroundProcess(
    views.filter((view) => view !== null),
    supervisor.pid("codex"),
  );
  if (work) {
    const name = work.args[0]?.split("/").at(-1) || "unknown";
    log(`[lifecycle] background process of the bot user ${work.pid}: ${name}`);
    return true;
  }
  const infrastructure = new Set([
    "Xvfb",
    "xfce4-session",
    "dbus-launch",
    "dbus-daemon",
    "xfconfd",
    "xfwm4",
    "xfsettingsd",
    "xfce4-panel",
    "thunar",
    "Thunar",
    "xfdesktop",
    "wrapper-2.0",
    "x11vnc",
    "chromium",
    "chrome_crashpad_handler",
  ]);
  for (const pid of await botProcesses(desktopUser.uid)) {
    // Containers commonly lack CAP_SYS_PTRACE, so /proc/<desktop-pid>/exe is unreadable
    // even by root. cmdline remains readable and is sufficient for conservative job detection.
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return "";
        throw error;
      },
    );
    const executable = command.split("\0")[0]?.split(/\s/)[0];
    if (!executable) continue;
    const name = executable.split("/").at(-1)!;
    if (
      (executable.includes("/") && !executable.startsWith("/usr/")) ||
      !infrastructure.has(name)
    ) {
      log(`[lifecycle] background desktop process ${pid}: ${name}`);
      return true;
    }
  }
  return false;
}
async function startCodex() {
  await supervisor.start({
    name: "codex",
    command: "codex",
    args: ["app-server", "--listen", `ws://127.0.0.1:${PORTS.codex}`],
    user: botUser,
    env: { CODEX_HOME: COMPUTER_PATHS.codexHome, TERM: "xterm-256color" },
    cwd: COMPUTER_PATHS.teammatesRoot,
    restart: "always",
    ready: () =>
      waitFor(
        async () => (await fetch(`http://127.0.0.1:${PORTS.codex}/readyz`)).ok,
        30_000,
        "the Codex app-server",
      ),
  });
}
const lifecycle: ComputeLifecycle = new ComputeLifecycle(lifecycleEnabled, {
  start: startCodex,
  ready: () => supervisor.isRunning("codex"),
  busy: async () => screens.busy || pageChecker.busy || (await hasBackgroundProcesses()),
  stop: async () => {
    await cookies.flush();
    await screens.stopAll();
    await supervisor.stop("codex");
    // Stopping Codex's process group ends its code-mode host too, but the host has a group of
    // its own, so it can still be exiting when the group stop returns.
    await waitFor(
      async () => (await botProcesses()).size === 0,
      5_000,
      "the bot user's processes to exit",
    );
    await cookies.persist();
  },
});

function health(): ComputerHealth {
  const agent = supervisor.state("codex");
  return {
    ok: agent === "running",
    bootedAt,
    agent,
    screens: screens.list(),
    egress: egress.state,
  };
}

async function main() {
  log("botd starting");
  // Files the teammates and the browser create stay writable by the whole `bots` group, so shared folders stay shared.
  process.umask(0o002);
  await prepareFilesystem();
  await codeScreens.load();
  await cookies.load();

  if (!lifecycleEnabled) await startCodex();

  egress.listen(PORTS.socks);
  await pagePreview.listen();

  const { server, broadcastHealth: broadcast } = createServer({
    token: token!,
    lifecycle,
    screens,
    egress,
    health,
    codexUrl: `ws://127.0.0.1:${PORTS.codex}`,
    pages: pageChecker,
    log,
  });
  server.listen(PORTS.botd, "0.0.0.0", () => log(`botd listening on :${PORTS.botd}`));

  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      if (!lifecycleEnabled || !(await hasBackgroundProcesses())) screens.sweep();
    })()
      .catch((error: unknown) => log(`[screens] idle sweep deferred: ${String(error)}`))
      .finally(() => {
        sweeping = false;
      });
  }, 5_000).unref();
  // Every teammate's browser stays signed in to the same sites.
  setInterval(
    () =>
      void cookies.sync().catch((error: unknown) => log(`[cookies] sync failed: ${String(error)}`)),
    2_000,
  ).unref();
  screens.on("lease", (screenId, { holder, reason }) =>
    log(
      `[lease] ${screenId.slice(0, 8)}: ${holder ? (isOwnerLease(holder) ? "you" : holder.teammateName) : "free"} (${reason})`,
    ),
  );
  supervisor.on("state", (name, state) => {
    log(`[supervisor] ${name} is ${state}`);
    broadcast();
  });
  broadcastHealth = broadcast;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`received ${signal}, stopping`);
    void cookies
      .flush()
      .then(() => screens.stopAll())
      .then(() => supervisor.stopAll())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log(`shutdown failed: ${String(error)}`);
        process.exit(1);
      });
  });
}

main().catch((error: unknown) => {
  log(`botd failed to start: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
