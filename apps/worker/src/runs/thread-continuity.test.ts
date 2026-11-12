import { describe, it, expect, vi } from "vitest";
import type { CodexClient } from "@open-bot/agent";
import type { Context } from "../context";
import {
  RunSession,
  type SessionServices,
  type SessionTools,
  type Bot,
  type Run,
  type Chat,
} from "./session";
import { configurationRevision } from "@open-bot/db";

const botId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const tools: SessionTools = { version: 7, specs: () => [], handle: vi.fn() };
/** A thread that last saw `seen` as its AGENTS.md; this run wrote `written`. */
function fixture(generation = "1:0:0", agents = { seen: "# Test", written: "# Test" }) {
  const request = vi.fn(async (method: string) => ({
    thread: { id: method === "thread/fork" ? "forked" : "fresh" },
  }));
  const select = vi.fn(() => ({
    from: () => ({
      where: async () => [
        {
          codexThreadId: "old",
          toolsVersion: tools.version,
          memoryGeneration: generation,
          authMode: "plan",
          configurationKey: configurationRevision({ connections: "", agents: agents.seen }),
        },
      ],
    }),
  }));
  const upsert = vi.fn(async () => {});
  const ctx = {
    db: { select, insert: () => ({ values: () => ({ onConflictDoUpdate: upsert }) }) },
    env: {},
    codex: { isLoaded: () => true, markLoaded: vi.fn(), ready: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const services = {
    tools,
    connections: async () => ({ key: "", config: {} }),
  } as unknown as SessionServices;
  const session = new RunSession(
    ctx,
    services,
    { id: runId, chatId: "chat" } as Run,
    { id: botId, slug: "test", name: "Test", model: "test", autonomy: "risky" } as Bot,
    { id: "chat" } as Chat,
  );
  session.memoryGeneration = "1:0:0";
  (session as unknown as { agentsFile: string }).agentsFile = agents.written;
  const ensure = () =>
    (session as unknown as { ensureThread(client: CodexClient): Promise<string> }).ensureThread({
      request,
    } as unknown as CodexClient);
  return { request, session, ensure };
}
/** A run picks up its Codex thread again only while that thread saw the memory and instructions it would now get. */
describe("memory and Codex thread continuity", () => {
  it("reuses a loaded thread only when the memory generation still matches", async () => {
    const f = fixture();
    expect(await f.ensure()).toBe("old");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("starts a fresh thread instead of forking stale memory after correction or forgetting", async () => {
    const f = fixture("0:0:0");
    expect(await f.ensure()).toBe("fresh");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("thread/start");
  });
  it("also resets threads when a previously recalled fact has expired", async () => {
    const f = fixture("1:0:0");
    f.session.memoryGeneration = "1:0:1";
    await f.ensure();
    expect(f.request.mock.calls[0]![0]).toBe("thread/start");
  });
  it("forks a continued conversation onto new instructions, keeping its history", async () => {
    // Codex reads AGENTS.md when a thread starts or forks; a loaded thread keeps the old one.
    const f = fixture("1:0:0", { seen: "# Test", written: "# Test\n\nAlways reply in French." });
    expect(await f.ensure()).toBe("forked");
    expect(f.request).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({ threadId: "old", cwd: expect.any(String) }),
    );
    // Codex ignores developer instructions on a fork, so none are sent.
    const [, params] = f.request.mock.calls[0] as unknown as [string, object];
    expect(params).not.toHaveProperty("developerInstructions");
  });
  it("clears MCP servers on a fork, so removed connections don't carry over", async () => {
    const f = fixture("1:0:0", { seen: "# Old", written: "# New" });
    await f.ensure();
    expect(f.request).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({ config: expect.objectContaining({ mcp_servers: {} }) }),
    );
  });
});
