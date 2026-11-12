// Shared by the ratchet checks in scripts/check: a baseline records today's debt, the check fails
// when the code is worse than the baseline or the baseline is worse than the code, and `--update`
// writes the code's state back only when nothing grew.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function repoRoot(cwd = process.cwd()) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

export function readBaseline(root, file, empty) {
  const full = path.join(root, file);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : empty;
}

export function writeBaseline(root, file, value) {
  writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}
