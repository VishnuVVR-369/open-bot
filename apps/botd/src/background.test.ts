import { describe, expect, it } from "vitest";
import { backgroundProcess, type ProcessView } from "./background";

// The process tree on the Railway computer after a turn that used code mode (Codex 0.162.1).
const BIN =
  "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin";
const launcher: ProcessView = {
  pid: 213,
  parent: 3,
  args: ["node", "/usr/local/bin/codex", "app-server", "--listen", "ws://127.0.0.1:4500"],
};
const native: ProcessView = {
  pid: 220,
  parent: 213,
  args: [`${BIN}/codex`, "app-server", "--listen", "ws://127.0.0.1:4500"],
};
const host: ProcessView = { pid: 296, parent: 220, args: [`${BIN}/codex-code-mode-host`] };

describe("background bot processes", () => {
  it("treats Codex, its native app-server and its code-mode host as no work", () => {
    expect(backgroundProcess([launcher, native], launcher.pid)).toBeUndefined();
    expect(backgroundProcess([launcher, native, host], launcher.pid)).toBeUndefined();
  });

  it("still counts what a code-mode cell or a turn starts as work", () => {
    const shell: ProcessView = { pid: 400, parent: 220, args: ["/bin/bash", "-lc", "sleep 60"] };
    const fromHost: ProcessView = { pid: 401, parent: 296, args: ["/usr/bin/curl", "-O", "x"] };
    expect(backgroundProcess([launcher, native, host, shell], launcher.pid)).toBe(shell);
    expect(backgroundProcess([launcher, native, host, fromHost], launcher.pid)).toBe(fromHost);
  });

  it("counts a code-mode host that Codex's app-server didn't start as work", () => {
    const orphan: ProcessView = { ...host, parent: 1 };
    const copy: ProcessView = { ...host, args: ["/tmp/codex-code-mode-host"] };
    const second: ProcessView = { pid: 500, parent: 213, args: [`${BIN}/codex`, "exec", "hi"] };
    const underSecond: ProcessView = { ...host, pid: 501, parent: 500 };
    expect(backgroundProcess([launcher, native, orphan], launcher.pid)).toBe(orphan);
    expect(backgroundProcess([launcher, native, copy], launcher.pid)).toBe(copy);
    expect(backgroundProcess([launcher, native, second, underSecond], launcher.pid)).toBe(second);
  });

  it("counts every bot process as work when Codex isn't running", () => {
    expect(backgroundProcess([native, host], undefined)).toBe(native);
    expect(backgroundProcess([], undefined)).toBeUndefined();
  });
});
