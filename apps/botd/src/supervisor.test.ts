import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor, waitFor, type ProcessSpec } from "./supervisor";
vi.mock("./users", () => ({
  asUser: (_user: unknown, command: string, args: string[]) => [command, args],
}));
const supervisors: Supervisor[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stopAll();
});
const spec = (args: string[], onSpawn = vi.fn()): ProcessSpec => ({
  name: "process",
  command: process.execPath,
  args,
  user: { uid: 1, gid: 1, name: "test", home: "/tmp" },
  restart: "always",
  quiet: true,
  ready: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  },
  onSpawn,
});
describe("supervisor lifecycle fences", () => {
  it("serializes simultaneous starts and stops and awaits child termination", async () => {
    const supervisor = new Supervisor(() => {});
    supervisors.push(supervisor);
    const spawn = vi.fn();
    const child = spec(["-e", "setInterval(() => {}, 1000)"], spawn);
    await Promise.all([supervisor.start(child), supervisor.start(child)]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await supervisor.stop("process");
    expect(supervisor.state("process")).toBe("stopped");
    const pid = spawn.mock.calls[0]![0].pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("a stale crash-restart callback cannot launch or replace a later process with the same name", async () => {
    const supervisor = new Supervisor(() => {});
    supervisors.push(supervisor);
    const spawn = vi.fn();
    await supervisor.start(spec(["-e", "process.exit(1)"], spawn));
    await waitFor(async () => supervisor.state("process") === "crashed", 1_000, "crash");
    await supervisor.stop("process");
    await supervisor.start(spec(["-e", "setInterval(() => {}, 1000)"], spawn));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.state("process")).toBe("running");
  });
  it("readiness failure propagates instead of declaring a failed start successful", async () => {
    const supervisor = new Supervisor(() => {});
    supervisors.push(supervisor);
    await expect(
      supervisor.start({
        ...spec(["-e", "setInterval(() => {}, 1000)"]),
        ready: async () => {
          throw new Error("not ready");
        },
      }),
    ).rejects.toThrow("not ready");
    await supervisor.stop("process");
  });
});
