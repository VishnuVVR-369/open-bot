import { readdir, rm } from "node:fs/promises";

/**
 * Removes the X display locks and sockets a previous boot left in `/tmp`, and returns their names.
 *
 * botd starts every X server, and it runs as the container's only child of tini, so when it starts
 * no X server is running. A container restarted after a crash keeps its `/tmp`, though, and Xvfb
 * refuses a display whose lock names a live process: after a restart that pid usually belongs to
 * some other process, so every screen would fail with "Server is already active for display".
 */
export async function clearStaleDisplays(tmp = "/tmp"): Promise<string[]> {
  const removed: string[] = [];
  const clear = async (dir: string, pattern: RegExp) => {
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.filter((n) => pattern.test(n))) {
      await rm(`${dir}/${name}`, { force: true });
      removed.push(name);
    }
  };
  await clear(tmp, /^\.X\d+-lock$/);
  await clear(`${tmp}/.X11-unix`, /^X\d+$/);
  return removed;
}
