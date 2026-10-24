import { z } from "zod";

/** The size of every screen. Screenshots are taken at this size, so coordinates map 1:1. */
export const SCREEN = { width: 1280, height: 800 } as const;

const x = z
  .number()
  .int()
  .min(0)
  .max(SCREEN.width - 1);
const y = z
  .number()
  .int()
  .min(0)
  .max(SCREEN.height - 1);

export const computerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("click"),
    x,
    y,
    button: z.enum(["left", "right", "middle"]).default("left"),
    clicks: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ action: z.literal("move"), x, y }),
  z.object({ action: z.literal("drag"), fromX: x, fromY: y, toX: x, toY: y }),
  z.object({
    action: z.literal("scroll"),
    x,
    y,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(25).default(5),
  }),
  z.object({ action: z.literal("type"), text: z.string().min(1).max(5000) }),
  z.object({ action: z.literal("key"), keys: z.string().min(1).max(100) }),
  z.object({ action: z.literal("open_url"), url: z.string().url() }),
  z.object({ action: z.literal("wait"), seconds: z.number().min(0.1).max(30) }),
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;
export type ComputerActionName = ComputerAction["action"];

/** Who currently holds a screen. `null` means it is free. */
export type LeaseHolder =
  | { kind: "user"; since: string; lastInputAt: string }
  | {
      kind: "run";
      runId: string;
      botId: string;
      botName: string;
      since: string;
      lastActionAt: string;
    }
  | null;

export interface RunIdentity {
  runId: string;
  botId: string;
  botName: string;
  /** The screen it works on, when it isn't the bot's own: a swarm helper's. */
  screenId?: string;
}

/** Error codes botd returns for desktop actions. */
export type ComputerErrorCode =
  "user_has_control" | "desktop_busy" | "invalid_action" | "wrong_site" | "failed";

/** Type a secret from the vault on a bot's screen, without it passing through the bot. */
export interface ComputerFillRequest {
  run: RunIdentity;
  secret: string;
  /** The site the browser must be showing, like github.com, or null to fill anywhere. */
  site: string | null;
}

export interface ComputerFillResult {
  ok: true;
  /** The addresses of the tabs showing when it filled. */
  pages: string[];
}

export interface ComputerActionResult {
  ok: true;
  /** JPEG screenshot taken after the action settled, base64 encoded. */
  screenshot: string;
  /** Pointer position after the action. */
  cursor: { x: number; y: number };
  /** Job portals where the apply guard stopped a submission during the action. */
  blocked?: string[];
}

/** The readable content of the page in front of a bot's browser. */
export interface PageContent {
  url: string;
  title: string;
  text: string;
  /** The text was longer and was cut. */
  truncated: boolean;
  links: { text: string; href: string }[];
}

export interface ComputerReadResult extends PageContent {
  ok: true;
  /** Job portals where the apply guard stopped a submission since the last action. */
  blocked?: string[];
}

export interface ComputerActionError {
  ok: false;
  code: ComputerErrorCode;
  message: string;
}

export const USER_HAS_CONTROL_MESSAGE =
  "The user has control of your screen. Do not use desktop tools until they hand it back. Continue with shell and file work, or end your turn and wait.";

export type ProcessState = "running" | "starting" | "stopped" | "crashed";

/**
 * Every bot has its own screen on the shared computer: a display with its own desktop and browser.
 * Screens start when a bot or you first use them and stop after a while unused.
 * Browser sign-ins are shared between all screens.
 */
export interface ScreenStatus {
  /** The bot the screen belongs to. */
  id: string;
  state: "starting" | "running" | "stopping";
  browser: ProcessState;
  lease: LeaseHolder;
}

export interface ComputerHealth {
  ok: boolean;
  bootedAt: string;
  /** The Codex app-server that runs every bot. */
  agent: ProcessState;
  /** Screens that are running. A bot without one gets it on first use. */
  screens: ScreenStatus[];
  egress: { mode: "off" | "prefer" | "require"; agentOnline: boolean; tunnelConnected: boolean };
}

/** Events botd streams to the worker. */
export type LeaseChangeReason =
  | "acquired"
  | "handed_back"
  | "user_idle"
  | "user_disconnected"
  | "run_finished"
  | "run_idle"
  | "preempted";

export type ComputerEvent =
  | { type: "lease"; screenId: string; holder: LeaseHolder; reason?: LeaseChangeReason }
  | { type: "health"; health: ComputerHealth };

/** Screen ids are bot ids, or a swarm helper's task id. */
export function isScreenId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}
