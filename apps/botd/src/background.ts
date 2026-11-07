import { dirname } from "node:path";

/** A bot process as /proc shows it without ptrace: its parent and its command line. */
export interface ProcessView {
  pid: number;
  parent: number;
  args: string[];
}

/** Codex starts this next to its native app-server binary, on the first code-mode `exec`. */
const CODE_MODE_HOST = "codex-code-mode-host";

/**
 * The first bot process that is work rather than Codex itself, if any.
 *
 * Codex itself is npm's launcher, the native app-server it runs, and the code-mode host that
 * app-server starts. The host stays up between turns, so it can't mean work on its own: a cell
 * that runs commands has them as app-server children, and a cell's tool calls are pending RPC
 * requests, which both still block sleep. Every other process, including shells, MCP servers,
 * detached jobs reparented to tini, and copies of Codex's binaries started any other way, is
 * independent work that must finish before the computer sleeps.
 */
export function backgroundProcess(
  processes: ProcessView[],
  launcher: number | undefined,
): ProcessView | undefined {
  const codex = new Set<number>();
  if (launcher !== undefined) {
    codex.add(launcher);
    const native = processes.find(
      (process) =>
        process.parent === launcher &&
        process.args[0]?.endsWith("/codex") &&
        process.args[1] === "app-server",
    );
    if (native) {
      codex.add(native.pid);
      const host = `${dirname(native.args[0]!)}/${CODE_MODE_HOST}`;
      for (const process of processes)
        if (process.parent === native.pid && process.args[0] === host) codex.add(process.pid);
    }
  }
  return processes.find((process) => !codex.has(process.pid));
}
