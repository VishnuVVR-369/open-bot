import { contextBridge } from "electron";

// The web app can tell it runs inside the desktop app. Nothing else is exposed.
contextBridge.exposeInMainWorld("openBotDesktop", { platform: process.platform });
