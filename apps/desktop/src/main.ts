import path from "node:path";
import { EgressAgent, type AgentStatus } from "@open-bot/egress";
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";

/** Where the web app lives. Locally the Next.js dev server; in production the deployed app. */
const APP_URL = process.env.OPEN_BOT_URL ?? "http://localhost:3000";
const APP_ORIGIN = new URL(APP_URL).origin;
const QUICK_CAPTURE_SHORTCUT = "CommandOrControl+Shift+Space";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let egressStatus: AgentStatus = "offline";
let egressDetail: string | undefined;

function asset(name: string) {
  return path.join(__dirname, "..", "assets", name);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "open-bot",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: "#f3f4f6",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Signing in happens in this window; reconnect browsing right after.
  win.webContents.on("did-navigate-in-page", () => agent.retryNow());
  win.webContents.on("did-navigate", () => agent.retryNow());
  void win.loadURL(APP_URL);

  // Stay inside the app; everything else opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Closing the window keeps open-bot running in the menu bar, so browsing through this Mac keeps working.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
  return win;
}

function showWindow(route?: string) {
  if (!window || window.isDestroyed()) window = createWindow();
  if (process.platform === "darwin") void app.dock?.show();
  if (route) void window.loadURL(new URL(route, APP_URL).toString());
  window.show();
  window.focus();
}

/** The egress agent signs in with the app's session cookie, so there is nothing to pair. */
const agent = new EgressAgent({
  getUrl: async () => {
    const response = await net.fetch(`${APP_URL}/api/desktop/egress-token`, {
      session: session.defaultSession,
    } as RequestInit);
    if (response.status === 401) throw new Error("Sign in to open-bot first");
    if (!response.ok) throw new Error(`The app returned ${response.status}`);
    const { url, token } = (await response.json()) as { url: string; token: string };
    return `${url}?token=${encodeURIComponent(token)}`;
  },
  onStatus: (status, detail) => {
    egressStatus = status;
    egressDetail = detail;
    updateTray();
  },
  log: (message) => console.log(`[egress] ${message}`),
});

function updateTray() {
  if (!tray) return;
  const statusLabel =
    egressStatus === "online"
      ? "Browsing through this Mac"
      : egressStatus === "connecting"
        ? "Connecting…"
        : `Not browsing through this Mac${egressDetail ? ` (${egressDetail})` : ""}`;
  const template: MenuItemConstructorOptions[] = [
    { label: "Open open-bot", click: () => showWindow() },
    { label: "Open the computer", click: () => showWindow("/computer") },
    { type: "separator" },
    { label: statusLabel, enabled: false },
    {
      label: "Reconnect",
      visible: egressStatus !== "online",
      click: () => {
        agent.stop();
        agent.start();
      },
    },
    { type: "separator" },
    {
      label: "Open at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit open-bot", accelerator: "CommandOrControl+Q", click: () => quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`open-bot · ${statusLabel}`);
}

function createTray() {
  const image = nativeImage.createFromPath(asset("trayTemplate.png"));
  image.setTemplateImage(true);
  tray = new Tray(image);
  updateTray();
}

function quit() {
  quitting = true;
  agent.stop();
  app.quit();
}

/** openbot://chats/<id> opens that chat. */
function handleDeepLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "openbot:") return;
    showWindow(`/${parsed.host}${parsed.pathname}`.replace(/\/+$/, "") || "/");
  } catch {
    showWindow();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient("openbot");
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith("openbot://"));
    if (link) handleDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  void app.whenReady().then(() => {
    // Notifications and clipboard for the app itself; nothing else.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const fromApp = new URL(webContents.getURL()).origin === APP_ORIGIN;
      callback(
        fromApp &&
          ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"].includes(
            permission,
          ),
      );
    });
    window = createWindow();
    createTray();
    agent.start();
    globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => showWindow());
  });

  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  // Keep running in the menu bar when every window is closed.
  app.on("window-all-closed", () => {});
}
