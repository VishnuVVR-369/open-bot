import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rm } from "node:fs/promises";
import type { ComputerAction } from "@open-bot/shared";
import { asUser, type SystemUser } from "./users";

export class ActionAbortedError extends Error {
  constructor() {
    super("The action was stopped because the user took control of the desktop");
    this.name = "ActionAbortedError";
  }
}

const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  meta: "super",
  super: "super",
  win: "super",
};

/** Turn "Ctrl+L Enter" style input into xdotool key names. */
export function normalizeKeys(keys: string): string[] {
  return keys
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((combo) =>
      combo
        .split("+")
        .map((key) => {
          const alias = KEY_ALIASES[key.toLowerCase()];
          if (alias) return alias;
          if (/^f([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
          return key;
        })
        .join("+"),
    );
}

const SCROLL_BUTTON = { up: "4", down: "5", left: "6", right: "7" } as const;
const MOUSE_BUTTON = { left: "1", middle: "2", right: "3" } as const;

export interface DesktopOptions {
  user: SystemUser;
  display: string;
  xauthority: string;
  /** Opens a URL in the desktop browser, starting it if needed. */
  openUrl: (url: string) => Promise<void>;
}

/** Drives the X desktop with xdotool and scrot, as the desktop user. */
export class Desktop {
  private readonly running = new Set<ChildProcess>();
  private generation = 0;
  private readonly shotsDir = "/tmp/botd-shots";

  constructor(private readonly options: DesktopOptions) {}

  /** Kill every in-flight input command. Actions started before this call fail with ActionAbortedError. */
  abortAll(): void {
    this.generation += 1;
    for (const child of this.running) child.kill("SIGKILL");
    this.running.clear();
  }

  /** Runs a command as the desktop user. `input` goes to its stdin, where other users can't see it. */
  private exec(
    command: string,
    args: string[],
    generation: number,
    input?: string,
  ): Promise<string> {
    if (generation !== this.generation) return Promise.reject(new ActionAbortedError());
    const [cmd, argv] = asUser(this.options.user, command, args, {
      DISPLAY: this.options.display,
      XAUTHORITY: this.options.xauthority,
    });
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
      this.running.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("exit", (code) => {
        this.running.delete(child);
        if (generation !== this.generation) reject(new ActionAbortedError());
        else if (code === 0) resolve(stdout);
        else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }

  private xdotool(args: string[], generation: number): Promise<string> {
    return this.exec("xdotool", args, generation);
  }

  /**
   * Type a secret from the vault into whatever has keyboard focus. It goes to xdotool's stdin rather
   * than its arguments, which every process on the computer can list.
   */
  async typeSecret(secret: string): Promise<void> {
    await this.exec(
      "xdotool",
      ["type", "--delay", "8", "--clearmodifiers", "--file", "-"],
      this.generation,
      secret,
    );
  }

  private async sleep(ms: number, generation: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (generation !== this.generation) throw new ActionAbortedError();
  }

  async perform(action: ComputerAction): Promise<void> {
    const generation = this.generation;
    switch (action.action) {
      case "screenshot":
        return;
      case "click":
        await this.xdotool(
          [
            "mousemove",
            "--sync",
            String(action.x),
            String(action.y),
            "click",
            "--repeat",
            String(action.clicks),
            "--delay",
            "80",
            MOUSE_BUTTON[action.button],
          ],
          generation,
        );
        return;
      case "move":
        await this.xdotool(["mousemove", "--sync", String(action.x), String(action.y)], generation);
        return;
      case "drag": {
        await this.xdotool(
          ["mousemove", "--sync", String(action.fromX), String(action.fromY), "mousedown", "1"],
          generation,
        );
        try {
          const steps = 12;
          for (let step = 1; step <= steps; step += 1) {
            const x = Math.round(action.fromX + ((action.toX - action.fromX) * step) / steps);
            const y = Math.round(action.fromY + ((action.toY - action.fromY) * step) / steps);
            await this.xdotool(["mousemove", String(x), String(y)], generation);
            await this.sleep(15, generation);
          }
        } finally {
          // Always release the button, even when aborted, so the desktop isn't left mid-drag.
          await this.exec("xdotool", ["mouseup", "1"], this.generation).catch(() => {});
        }
        return;
      }
      case "scroll":
        await this.xdotool(
          [
            "mousemove",
            "--sync",
            String(action.x),
            String(action.y),
            "click",
            "--repeat",
            String(action.amount),
            "--delay",
            "40",
            SCROLL_BUTTON[action.direction],
          ],
          generation,
        );
        return;
      case "type":
        // Type in chunks, so taking over stops a long text within a fraction of a second.
        for (let offset = 0; offset < action.text.length; offset += 40) {
          await this.xdotool(
            [
              "type",
              "--delay",
              "8",
              "--clearmodifiers",
              "--",
              action.text.slice(offset, offset + 40),
            ],
            generation,
          );
        }
        return;
      case "key":
        await this.xdotool(
          ["key", "--clearmodifiers", "--", ...normalizeKeys(action.keys)],
          generation,
        );
        return;
      case "open_url":
        await this.options.openUrl(action.url);
        await this.sleep(1_500, generation);
        return;
      case "wait":
        await this.sleep(action.seconds * 1000, generation);
        return;
    }
  }

  /** Settle time after an action, so the screenshot shows its effect. */
  static settleMs(action: ComputerAction): number {
    switch (action.action) {
      case "screenshot":
      case "wait":
      case "move":
        return 0;
      case "open_url":
        return 500;
      default:
        return 450;
    }
  }

  /** Create the screenshot folder, owned by the desktop user who writes into it. */
  async init(): Promise<void> {
    await mkdir(this.shotsDir, { recursive: true, mode: 0o700 });
    await chown(this.shotsDir, this.options.user.uid, this.options.user.gid);
  }

  async screenshot(): Promise<Buffer> {
    const path = `${this.shotsDir}/${randomUUID()}.jpg`;
    try {
      // Screenshots are not aborted by a takeover; they never change the desktop.
      await this.exec(
        "scrot",
        ["--overwrite", "--pointer", "--quality", "72", path],
        this.generation,
      );
      return await readFile(path);
    } finally {
      await rm(path, { force: true });
    }
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const output = await this.xdotool(["getmouselocation", "--shell"], this.generation);
    const x = Number(/X=(\d+)/.exec(output)?.[1] ?? 0);
    const y = Number(/Y=(\d+)/.exec(output)?.[1] ?? 0);
    return { x, y };
  }

  /** True once the X server accepts connections. */
  async isDisplayReady(): Promise<boolean> {
    try {
      await this.xdotool(["getdisplaygeometry"], this.generation);
      return true;
    } catch {
      return false;
    }
  }
}
