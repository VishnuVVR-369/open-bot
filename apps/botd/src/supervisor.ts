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
    {
      spec: ProcessSpec;
      child: ChildProcess | null;
      group: ChildProcess | null;
      state: ProcessState;
      failures: number;
    }
  >();
  private stopping = false;
  private readonly transitions = new Map<string, Promise<void>>();

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

  pid(name: string): number | undefined {
    return this.processes.get(name)?.child?.pid;
  }

  start(spec: ProcessSpec): Promise<void> {
    return this.serial(spec.name, () => this.startProcess(spec));
  }

  private serial(name: string, work: () => Promise<void>): Promise<void> {
    const next = (this.transitions.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
    this.transitions.set(name, next);
    void next
      .finally(() => {
        if (this.transitions.get(name) === next) this.transitions.delete(name);
      })
      .catch(() => {});
    return next;
  }

  private async startProcess(spec: ProcessSpec): Promise<void> {
    const existing = this.processes.get(spec.name);
    if (existing && (existing.state === "running" || existing.state === "starting")) return;
    const entry = existing ?? {
      spec,
      child: null,
      group: null,
      state: "stopped" as ProcessState,
      failures: 0,
    };
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
    entry.group = child;
    child.on("error", (error) => this.log(`[${name}] ${String(error)}`));
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
      setTimeout(() => {
        if (this.processes.get(name) === entry && !this.stopping && !entry.child)
          void this.serial(name, async () => {
            if (this.processes.get(name) === entry && !entry.child) await this.launch(name);
          }).catch((error: unknown) => this.log(`${prefix}restart failed: ${String(error)}`));
      }, delay).unref();
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
      await terminate([child]);
      throw error;
    }
  }

  /** Stop a process and forget it. */
  stop(name: string): Promise<void> {
    return this.serial(name, () => this.stopProcess(name));
  }

  private async stopProcess(name: string): Promise<void> {
    const entry = this.processes.get(name);
    if (!entry) return;
    const child = entry.child ?? entry.group;
    // Remove only after verified termination. Failed shutdown must remain visible and retryable.
    entry.spec = { ...entry.spec, restart: "never" };
    if (child) await terminate([child]);
    this.processes.delete(name);
    entry.child = null;
    this.emit("state", name, "stopped");
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.processes.keys()].map((name) => this.stop(name)));
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
export async function terminate(children: ChildProcess[]): Promise<void> {
  const alive = (child: ChildProcess) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // A process group in an exit/permission transition is not verified dead. Keep waiting;
      // a persistent inability to verify it still fails the bounded shutdown below.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  };
  for (const child of children) killGroup(child, "SIGTERM");
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (children.some(alive) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return !children.some(alive);
  };
  if (await wait(3_000)) return;
  for (const child of children) if (alive(child)) killGroup(child, "SIGKILL");
  if (!(await wait(3_000))) throw new Error("Process groups did not exit after SIGKILL");
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
