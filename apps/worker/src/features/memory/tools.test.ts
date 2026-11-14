import { describe, expect, it, vi } from "vitest";
import type { RunSession } from "../../runs/session";
import { toolNamed } from "../../tools/definitions";
import { parseArgs } from "../../core/tool";
import type { ToolDeps } from "../../tools/dependencies";

const SESSION = {
  bot: { id: "b1" }, // vocabulary: allow
  now: () => "2026-11-13T00:00:00.000Z",
  putItem: vi.fn(),
} as unknown as RunSession;

/** Calls `remember_about_user` as Codex would, with a memory store that saves anything it's given. */
async function rememberAboutUser(raw: Record<string, unknown>) {
  const save = vi.fn(async () => ({ id: "m1", revision: 1, state: "active" }));
  const memory = {
    actor: async () => ({ kind: "bot", botId: "b1", runId: "r1", verified: true }), // vocabulary: allow
    store: { save },
    refreshAfterWrite: async () => {},
  };
  const tool = toolNamed("remember_about_user")!;
  const call = tool.handle({ session: SESSION, callId: "c1", args: parseArgs(tool, raw), raw }, {
    memory,
  } as unknown as ToolDeps);
  return { call, save };
}

describe("remember_about_user", () => {
  it("saves the fact to the shared profile", async () => {
    const { call, save } = await rememberAboutUser({ fact: "Vegetarian" });
    await call;
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ botId: null, content: "Vegetarian", expiresAt: null }), // vocabulary: allow
      expect.anything(),
    );
  });

  it("refuses metadata memory refuses, rather than saving the fact without it", async () => {
    for (const extra of [{ expires_at: "not-a-date" }, { kind: "rumor" }, { key: "" }]) {
      const { call, save } = await rememberAboutUser({ fact: "Vegetarian", ...extra });
      await expect(call, JSON.stringify(extra)).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
    }
  });
});
