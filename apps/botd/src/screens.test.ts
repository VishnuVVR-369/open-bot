import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./screens";

/** The arguments a POSIX shell gets back from `quoted`, the way /etc/chromium.d/open-bot reads them. */
function shellArgs(quoted: string): string[] {
  const output = execFileSync("sh", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "sh", quoted], {
    cwd: "/",
  }).toString();
  return output.split("\0").slice(0, -1);
}

describe("shellQuote", () => {
  it("keeps every argument whole through a shell, without splitting or globbing", () => {
    const args = [
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--user-data-dir=/home/desktop/screens/a b/chromium",
      "--no-sandbox",
      'it\'s $HOME `id` "quoted"',
      "",
    ];
    expect(shellArgs(shellQuote(args))).toEqual(args);
  });
});
