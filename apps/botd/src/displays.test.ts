import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStaleDisplays } from "./displays";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("stale X displays", () => {
  it("removes the locks and sockets a crashed boot left, and nothing else", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "openbot-displays-"));
    directories.push(tmp);
    await mkdir(join(tmp, ".X11-unix"));
    // What Xvfb leaves for display :10 when the container is killed, next to unrelated files.
    await writeFile(join(tmp, ".X10-lock"), "        42\n");
    await writeFile(join(tmp, ".X11-lock"), "        43\n");
    await writeFile(join(tmp, ".X11-unix", "X10"), "");
    await writeFile(join(tmp, "keep.txt"), "");
    await writeFile(join(tmp, ".X10-lock.bak"), "");
    await writeFile(join(tmp, ".X11-unix", "Xkeep"), "");

    expect((await clearStaleDisplays(tmp)).sort()).toEqual([".X10-lock", ".X11-lock", "X10"]);
    expect((await readdir(tmp)).sort()).toEqual([".X10-lock.bak", ".X11-unix", "keep.txt"]);
    expect(await readdir(join(tmp, ".X11-unix"))).toEqual(["Xkeep"]);
  });

  it("does nothing on a fresh container", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "openbot-displays-"));
    directories.push(tmp);
    expect(await clearStaleDisplays(tmp)).toEqual([]);
  });
});
