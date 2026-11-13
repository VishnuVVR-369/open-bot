// The inexpensive gates shared by local verification and CI. Success is quiet;
// failures retain the command's complete stdout and stderr, and all gates run.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CHECKS = [
  "format:check",
  "lint",
  "check:doc-paths",
  "check:vocabulary",
  "check:file-size",
  "check:imports",
];

export function runChecks(commands, { cwd = process.cwd(), report = console.error } = {}) {
  let failed = false;
  for (const [command, ...args] of commands) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 0 && !result.error) continue;
    failed = true;
    report(`Failed: ${[command, ...args].join(" ")}`);
    if (result.stdout) report(result.stdout.trimEnd());
    if (result.stderr) report(result.stderr.trimEnd());
    if (result.error) report(result.error.message);
    if (result.signal) {
      report(`Terminated by ${result.signal}`);
      return 1;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runChecks(CHECKS.map((script) => ["pnpm", "--silent", script]));
}
