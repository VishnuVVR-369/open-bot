import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeScreens } from "./code-screens";
import { ScreenLease } from "./lease";
import type { Screen } from "./screens";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "openbot-code-"));
  directories.push(dir);
  const codes = new CodeScreens(dir);
  await codes.load();
  const state = { safe: false, site: "example.com" as string | null };
  const lease = new ScreenLease();
  const screen = {
    id: "00000000-0000-4000-8000-000000000001",
    lease,
    codeSite: vi.fn(async () => state.site),
    checkCode: vi.fn(async (_text: string, clear: boolean) => {
      if (clear) state.safe = true;
      return state.safe;
    }),
    clearRecoveredCode: vi.fn(async () => true),
    desktop: { typeSecret: vi.fn(async () => {}), perform: vi.fn(async () => {}) },
  } as unknown as Screen;
  const input = {
    operationId: "00000000-0000-4000-8000-000000000002",
    expectedSite: "example.com",
    text: "582913",
    pressEnter: false,
  };
  return { dir, codes, screen, state, input };
}

describe("code-protected screens", () => {
  it("persists only the screen id before typing and never persists the code", async () => {
    const { dir, codes, screen, input } = await fixture();
    vi.mocked(screen.desktop.typeSecret).mockImplementation(async () => {
      expect(await readdir(dir)).toEqual([screen.id]);
      expect(await readFile(join(dir, screen.id), "utf8")).toBe("");
      expect(screen.lease.holder?.kind).toBe("user-code");
      expect(
        await screen.lease.acquireForRun({
          runId: "run",
          teammateId: screen.id,
          teammateName: "Teammate",
        }),
      ).toBe("user_has_control");
    });
    expect(await codes.type(screen, input)).toMatchObject({ status: "needs_owner" });
    expect(screen.desktop.typeSecret).toHaveBeenCalledExactlyOnceWith(input.text);
  });

  it("never types a duplicate operation or a second operation on a protected screen", async () => {
    const { codes, screen, input } = await fixture();
    await codes.type(screen, input);
    expect((await codes.type(screen, input)).status).toBe("unknown");
    expect((await codes.type(screen, { ...input, operationId: "other" })).status).toBe("failed");
    expect(screen.desktop.typeSecret).toHaveBeenCalledTimes(1);
  });

  it("reports the run it preempted, so that run can continue after the hand-back", async () => {
    const { codes, screen, input } = await fixture();
    const run = { runId: "run", teammateId: screen.id, teammateName: "Teammate" };
    expect(await screen.lease.acquireForRun(run)).toBe("ok");
    expect(await codes.type(screen, input)).toMatchObject({
      status: "needs_owner",
      previous: { kind: "run", runId: "run" },
    });
  });

  it("refuses a different site without typing or leaving an owner lease", async () => {
    const { codes, screen, input } = await fixture();
    expect((await codes.type(screen, { ...input, expectedSite: "attacker.example" })).status).toBe(
      "failed",
    );
    expect(screen.desktop.typeSecret).not.toHaveBeenCalled();
    expect(screen.lease.holder).toBeNull();
  });

  it("checks the focused site again after persisting protection", async () => {
    const { codes, screen, input } = await fixture();
    vi.mocked(screen.codeSite)
      .mockResolvedValueOnce("example.com")
      .mockResolvedValueOnce("other.example");
    expect((await codes.type(screen, input)).status).toBe("needs_owner");
    expect(screen.desktop.typeSecret).not.toHaveBeenCalled();
    expect(screen.lease.holder?.kind).toBe("user-code");
  });

  it("blocks ordinary hand-back until the code is safe, including after converting to user control", async () => {
    const { codes, screen, input, state, dir } = await fixture();
    await codes.type(screen, input);
    screen.lease.takeByUser();
    expect(screen.lease.holder?.kind).toBe("user");
    expect(screen.lease.releaseByUser()).toBe(false);
    expect(await screen.lease.releaseSafely()).toBe(false);
    state.safe = true;
    expect(await screen.lease.releaseSafely()).toBe(true);
    expect(screen.lease.holder).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it("explicit clearing rechecks before release", async () => {
    const { codes, screen, input } = await fixture();
    await codes.type(screen, input);
    expect(await screen.lease.releaseSafely("handed_back", true)).toBe(true);
    expect(screen.checkCode).toHaveBeenCalledWith(input.text, true);
  });

  it("keeps control if clearing cannot prove safety", async () => {
    const { codes, screen, input } = await fixture();
    vi.mocked(screen.checkCode).mockResolvedValue(false);
    await codes.type(screen, input);
    expect(await screen.lease.releaseSafely("user_idle", true)).toBe(false);
    expect(screen.lease.holder).toMatchObject({ pausedForSafety: true });
  });

  it("restores quarantine after restart without needing the forgotten code", async () => {
    const { dir, codes, screen, input } = await fixture();
    await codes.type(screen, input);
    const restarted = new CodeScreens(dir);
    await restarted.load();
    const fresh = { ...screen, lease: new ScreenLease() } as Screen;
    restarted.attach(fresh);
    expect(fresh.lease.holder).toMatchObject({ kind: "user-code", pausedForSafety: true });
    expect(await fresh.lease.releaseSafely()).toBe(false);
    // A timeout never discards pages on its own: the screen stays paused until you act.
    expect(await fresh.lease.releaseSafely("user_idle", true)).toBe(false);
    expect(fresh.clearRecoveredCode).not.toHaveBeenCalled();
    expect(fresh.lease.holder).toMatchObject({ pausedForSafety: true });
    expect(await fresh.lease.releaseSafely("handed_back", true)).toBe(true);
    expect(fresh.clearRecoveredCode).toHaveBeenCalled();
  });

  it("keeps protection if input or the CDP safety check fails", async () => {
    const { codes, screen, input } = await fixture();
    vi.mocked(screen.desktop.typeSecret).mockRejectedValue(new Error("input failed"));
    expect((await codes.type(screen, input)).status).toBe("unknown");
    vi.mocked(screen.checkCode).mockRejectedValue(new Error("CDP unavailable"));
    expect(await screen.lease.releaseSafely()).toBe(false);
    expect(screen.lease.holder).toMatchObject({ pausedForSafety: true });
  });
});
