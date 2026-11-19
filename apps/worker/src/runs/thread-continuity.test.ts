import { describe, it, expect, vi } from "vitest";
import type { CodexClient } from "@open-bot/agent";
import type { Context } from "../context";
import type { Bot, Chat, Run } from "../core/db-types";
import { RunSession, type SessionServices, type SessionTools } from "./session";
import { ensureThread } from "./session/threads";
import { DEVELOPER_INSTRUCTIONS } from "../instructions";
import { toolsRevision } from "./tools-revision";
import { configurationRevision } from "@open-bot/db";
import { UnloggedApiKeyError } from "../features/model-access";
import { modelProxyUrl } from "../features/model-logs";

const botId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const spec = { type: "function", name: "a_tool", description: "Does a thing.", inputSchema: {} };
const tools: SessionTools = { specs: () => [spec] as never, handle: vi.fn() };
/** The revision a thread started with the current tools and instructions has. */
const current = toolsRevision(DEVELOPER_INSTRUCTIONS, tools.specs());
/** A thread that last saw `seen` as its AGENTS.md; this run wrote `written`. */
function fixture(
  generation = "1:0:0",
  agents = { seen: "# Test", written: "# Test" },
  revision: string | null = current,
  version = 0,
  access: { mode: "plan" | "api_key"; savedRoute?: string; env?: object } = { mode: "plan" },
) {
  const request = vi.fn(async (method: string) => ({
    thread: { id: method === "thread/fork" ? "forked" : "fresh" },
  }));
  const select = vi.fn(() => ({
    from: () => ({
      where: async () => [
        {
          codexThreadId: "old",
          toolsVersion: version,
          toolsRevision: revision,
          memoryGeneration: generation,
          authMode: access.mode,
          configurationKey: configurationRevision({
            connections: "",
            agents: agents.seen,
            route: access.savedRoute,
          }),
        },
      ],
    }),
  }));
  const upsert = vi.fn(async () => {});
  const ctx = {
    db: { select, insert: () => ({ values: () => ({ onConflictDoUpdate: upsert }) }) },
    env: access.env ?? {},
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
  session.agentsFile = agents.written;
  session.authMode = access.mode;
  session.apiKey = access.mode === "api_key" ? "sk-test" : null;
  const ensure = () => ensureThread(session, { request } as unknown as CodexClient);
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
  it("starts a fresh thread when the tools or developer instructions changed", async () => {
    // Codex keeps a thread's tools and instructions for life, so it can't continue onto new ones.
    for (const revision of [toolsRevision("Older rules.", tools.specs()), null]) {
      const f = fixture("1:0:0", undefined, revision);
      expect(await f.ensure()).toBe("fresh");
      expect(f.request.mock.calls[0]![0]).toBe("thread/start");
    }
    expect(toolsRevision(DEVELOPER_INSTRUCTIONS, [])).not.toBe(current);
  });
  it("starts a fresh thread when a worker from before the revision saved it last", async () => {
    // That worker writes its TOOLS_VERSION and leaves the revision another worker recorded.
    const f = fixture("1:0:0", undefined, current, 21);
    expect(await f.ensure()).toBe("fresh");
    expect(f.request.mock.calls[0]![0]).toBe("thread/start");
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

/** A loaded Codex thread keeps its provider's address, so a change in routing forks it once. */
describe("model proxy routing and Codex thread continuity", () => {
  const env = {
    OPENAI_API_BASE_URL: "https://api.openai.com/v1",
    MODEL_PROXY: true,
    WORKER_PORT: 4001,
    ENCRYPTION_KEY: "test-encryption-key",
    RAILWAY_PRIVATE_DOMAIN: "worker.railway.internal",
  };
  const proxy = modelProxyUrl(env, "api")!;
  const forkConfig = (f: ReturnType<typeof fixture>) =>
    (f.request.mock.calls[0] as unknown as [string, { config: Record<string, unknown> }])[1].config[
      "model_providers.openai-api"
    ];

  it("forks an API key thread from before the proxy onto it, without the key", async () => {
    const f = fixture("1:0:0", undefined, current, 0, { mode: "api_key", env });
    expect(await f.ensure()).toBe("forked");
    expect(forkConfig(f)).toEqual({ name: "OpenAI API", base_url: proxy, wire_api: "responses" });
    expect(JSON.stringify(f.request.mock.calls)).not.toContain("sk-test");
  });

  it("keeps a proxied API key thread while its route stays the same", async () => {
    const f = fixture("1:0:0", undefined, current, 0, { mode: "api_key", savedRoute: proxy, env });
    expect(await f.ensure()).toBe("old");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("never sends it around the proxy when the proxy is turned off", async () => {
    const f = fixture("1:0:0", undefined, current, 0, {
      mode: "api_key",
      savedRoute: proxy,
      env: { ...env, MODEL_PROXY: false },
    });
    // The key's spend is counted from the model logs, so it has no direct route.
    await expect(f.ensure()).rejects.toBeInstanceOf(UnloggedApiKeyError);
    expect(f.request).not.toHaveBeenCalled();
  });

  const planRoute = `${modelProxyUrl(env, "plan")!}/backend-api/codex`;
  const forkParams = (f: ReturnType<typeof fixture>) =>
    (f.request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

  it("forks a plan thread from before the proxy onto its plan route, on Codex's own provider", async () => {
    const f = fixture("1:0:0", undefined, current, 0, { mode: "plan", env });
    expect(await f.ensure()).toBe("forked");
    expect(f.request.mock.calls[0]![0]).toBe("thread/fork");
    expect(forkParams(f)).toMatchObject({
      threadId: "old",
      modelProvider: "openai",
      config: expect.objectContaining({ openai_base_url: planRoute }),
    });
  });

  it("keeps a proxied plan thread while its route stays the same", async () => {
    const f = fixture("1:0:0", undefined, current, 0, { mode: "plan", savedRoute: planRoute, env });
    expect(await f.ensure()).toBe("old");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("forks a plan thread back to ChatGPT when the proxy is turned off", async () => {
    const f = fixture("1:0:0", undefined, current, 0, {
      mode: "plan",
      savedRoute: planRoute,
      env: { ...env, MODEL_PROXY: false },
    });
    expect(await f.ensure()).toBe("forked");
    expect(forkParams(f).config).not.toHaveProperty("openai_base_url");
  });
});
