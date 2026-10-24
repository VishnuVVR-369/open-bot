import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ProcessState } from "@open-bot/shared";
import { asUser, type SystemUser } from "./users";

export type { ProcessState };

export interface ProcessSpec {
  name: string;
  command: string;
  args: string[];
  user: SystemUser;
  env?: Record<string, string>;
  cwd?: string;
  /** `always` restarts on exit; `never` leaves it stopped (used for apps you can close, like Chromium). */
  restart: "always" | "never";
  /** Drop the process's output instead of logging it. */
  quiet?: boolean;
  /** Open two extra pipes as fds 3 and 4, for Chromium's `--remote-debugging-pipe`. */
  debugPipe?: boolean;
  /** Called with each new child process, before it is ready. */
  onSpawn?: (child: ChildProcess) => void;
  /** Resolves once the process is ready to use. */
  ready?: () => Promise<void>;
}

const MAX_BACKOFF_MS = 15_000;

/** Starts processes as their users, restarts them with backoff, and reports their state. */
export class Supervisor extends EventEmitter<{ state: [string, ProcessState] }> {
  private readonly processes = new Map<
    string,
    { spec: ProcessSpec; child: ChildProcess | null; state: ProcessState; failures: number }
  >();
  private stopping = false;

  constructor(private readonly log: (message: string) => void) {
    super();
  }

  states(): Record<string, ProcessState> {
    return Object.fromEntries([...this.processes].map(([name, entry]) => [name, entry.state]));
  }

  state(name: string): ProcessState {
    return this.processes.get(name)?.state ?? "stopped";
  }

  isRunning(name: string): boolean {
    return this.processes.get(name)?.state === "running";
  }

  async start(spec: ProcessSpec): Promise<void> {
    const existing = this.processes.get(spec.name);
    if (existing && (existing.state === "running" || existing.state === "starting")) return;
    const entry = existing ?? { spec, child: null, state: "stopped" as ProcessState, failures: 0 };
    entry.spec = spec;
    this.processes.set(spec.name, entry);
    await this.launch(spec.name);
  }

  private setState(name: string, state: ProcessState) {
    const entry = this.processes.get(name);
    if (!entry || entry.state === state) return;
    entry.state = state;
    this.emit("state", name, state);
  }

  private async launch(name: string): Promise<void> {
    const entry = this.processes.get(name);
    if (!entry || this.stopping) return;
    const { spec } = entry;
    this.setState(name, "starting");
    const [command, args] = asUser(spec.user, spec.command, spec.args, spec.env);
    const output = spec.quiet ? "ignore" : "pipe";
    const child = spawn(command, args, {
      cwd: spec.cwd ?? spec.user.home,
      stdio: ["ignore", output, output, ...(spec.debugPipe ? (["pipe", "pipe"] as const) : [])],
      // Its own process group, so stopping it also stops everything it started.
      detached: true,
    });
    entry.child = child;
    spec.onSpawn?.(child);
    const prefix = `[${name}] `;
    child.stdout?.on("data", (chunk: Buffer) => this.log(prefix + chunk.toString().trimEnd()));
    child.stderr?.on("data", (chunk: Buffer) => this.log(prefix + chunk.toString().trimEnd()));
    child.on("exit", (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      if (this.stopping) {
        this.setState(name, "stopped");
        return;
      }
      const clean = code === 0 || signal === "SIGTERM";
      this.log(`${prefix}exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      if (entry.spec.restart === "never") {
        this.setState(name, clean ? "stopped" : "crashed");
        return;
      }
      this.setState(name, "crashed");
      entry.failures += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (entry.failures - 1));
      setTimeout(() => void this.launch(name), delay);
    });

    try {
      await spec.ready?.();
      if (entry.child === child) {
        this.setState(name, "running");
        // A process that stays up for a minute has recovered, so reset its backoff.
        setTimeout(() => {
          if (entry.child === child) entry.failures = 0;
        }, 60_000);
      }
    } catch (error) {
      this.log(`${prefix}did not become ready: ${String(error)}`);
      killGroup(child, "SIGTERM");
    }
  }

  /** Stop a process and forget it. */
  async stop(name: string): Promise<void> {
    const entry = this.processes.get(name);
    if (!entry) return;
    this.processes.delete(name);
    const child = entry.child;
    entry.child = null;
    if (child) await terminate([child]);
    this.emit("state", name, "stopped");
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const children = [...this.processes.values()].map((entry) => entry.child);
    await terminate(children.filter((child): child is ChildProcess => child !== null));
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** SIGTERM the processes' groups, then SIGKILL whatever is still running after a grace period. */
async function terminate(children: ChildProcess[]): Promise<void> {
  const exited = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      }),
  );
  for (const child of children) killGroup(child, "SIGTERM");
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000));
  if ((await Promise.race([Promise.all(exited), timeout])) === "timeout") {
    for (const child of children) killGroup(child, "SIGKILL");
  }
}

/** Poll until `check` succeeds or the timeout passes. */
export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
