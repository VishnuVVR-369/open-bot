import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import { COMPUTER_PATHS, type ComputerHealth } from "@open-bot/shared";
import { CookieSync } from "./cookies";
import { EgressRouter } from "./egress";
import { browserSandboxAvailable } from "./sandbox";
import { ScreenManager } from "./screens";
import { createServer } from "./server";
import { Supervisor, waitFor } from "./supervisor";
import { lookupUser } from "./users";

const PORTS = { botd: 7000, codex: 4500, socks: 1080 } as const;
/** botd's own state, which no bot can read: the shared cookie jar. */
const STATE_DIR = "/home/.botd";

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

const token = process.env.BOTD_TOKEN;
if (!token || token.length < 16) {
  log("BOTD_TOKEN must be set to at least 16 characters");
  process.exit(1);
}

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
  const shared = { uid: botUser.uid, gid: Number(process.env.BOTS_GID ?? botUser.gid) };
  await ensureDir(botUser.home, botGroup, 0o755);
  await ensureDir(COMPUTER_PATHS.botsRoot, botGroup, 0o755);
  await ensureDir(COMPUTER_PATHS.shared, shared, 0o2775);
  await ensureDir(COMPUTER_PATHS.downloads, shared, 0o2775);
  await ensureDir(COMPUTER_PATHS.codexHome, botGroup, 0o700);
  await writeFile(`${COMPUTER_PATHS.codexHome}/config.toml`, CODEX_CONFIG);
  await chown(`${COMPUTER_PATHS.codexHome}/config.toml`, botUser.uid, botUser.gid);
  await ensureDir(desktopUser.home, { uid: desktopUser.uid, gid: desktopUser.gid }, 0o750);
  await ensureDir(STATE_DIR, { uid: 0, gid: 0 }, 0o700);
}

const browserSandbox = await browserSandboxAvailable(desktopUser);
if (!browserSandbox) {
  log(
    "WARNING: this host refuses the user namespaces Chromium's sandbox needs, so browsers run with --no-sandbox",
  );
}

const supervisor = new Supervisor(log);
let broadcastHealth = () => {};
const egress = new EgressRouter(log, () => broadcastHealth());
const cookies = new CookieSync(`${STATE_DIR}/cookies.json`, log);
const screens = new ScreenManager(
  {
    supervisor,
    cookies,
    desktopUser,
    browserSandbox,
    socksPort: PORTS.socks,
    legacyProfile: `${desktopUser.home}/.config/chromium`,
    // Extra sites the apply guard covers, besides the job portals: the e2e tests' stand-in portal.
    applyGuardExtraDomains: (process.env.APPLY_GUARD_EXTRA_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean),
    log,
  },
  {
    maxRunning: Number(process.env.MAX_SCREENS ?? 4),
    idleMs: Number(process.env.SCREEN_IDLE_MINUTES ?? 20) * 60_000,
  },
);

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
  // Files the bots and the browser create stay writable by the whole `bots` group, so shared folders stay shared.
  process.umask(0o002);
  await prepareFilesystem();
  await cookies.load();

  await supervisor.start({
    name: "codex",
    command: "codex",
    args: ["app-server", "--listen", `ws://127.0.0.1:${PORTS.codex}`],
    user: botUser,
    env: { CODEX_HOME: COMPUTER_PATHS.codexHome, TERM: "xterm-256color" },
    cwd: COMPUTER_PATHS.botsRoot,
    restart: "always",
    ready: () =>
      waitFor(
        async () => (await fetch(`http://127.0.0.1:${PORTS.codex}/readyz`)).ok,
        30_000,
        "the Codex app-server",
      ),
  });

  egress.listen(PORTS.socks);

  const { server, broadcastHealth: broadcast } = createServer({
    token: token!,
    screens,
    egress,
    health,
    codexUrl: `ws://127.0.0.1:${PORTS.codex}`,
    log,
  });
  server.listen(PORTS.botd, "0.0.0.0", () => log(`botd listening on :${PORTS.botd}`));

  setInterval(() => screens.sweep(), 5_000).unref();
  // Every bot's browser stays signed in to the same sites.
  setInterval(() => void cookies.sync(), 2_000).unref();
  screens.on("lease", (screenId, { holder, reason }) =>
    log(
      `[lease] ${screenId.slice(0, 8)}: ${holder ? (holder.kind === "user" ? "you" : holder.botName) : "free"} (${reason})`,
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
      .persist()
      .catch(() => {})
      .then(() => screens.stopAll())
      .then(() => supervisor.stopAll())
      .then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  log(`botd failed to start: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
