import { describe, it, expect, vi } from "vitest";
import type { CodexClient } from "@open-bot/agent";
import type { Context } from "../context";
import { RunSession, type SessionServices, type Bot, type Run, type Chat } from "./session";
import { TOOLS_VERSION } from "../tools/definitions";
import { MemoryCoordinator } from "../services/memory";

const botId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const messageId = "00000000-0000-4000-8000-000000000003";
function fixture(generation = "1:0:0") {
  const request = vi.fn(async (method: string) => ({
    thread: { id: method === "thread/fork" ? "forked" : "fresh" },
  }));
  const select = vi.fn(() => ({
    from: () => ({
      where: async () => [
        {
          codexThreadId: "old",
          toolsVersion: TOOLS_VERSION,
          memoryGeneration: generation,
          authMode: "plan",
          connectionsKey: "",
        },
      ],
    }),
  }));
  const upsert = vi.fn(async () => {});
  const pool = { query: vi.fn(async () => ({ rows: [] })) };
  const ctx = {
    pool,
    db: { select, insert: () => ({ values: () => ({ onConflictDoUpdate: upsert }) }) },
    env: {},
    codex: { isLoaded: () => true, markLoaded: vi.fn(), ready: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const services = {
    connections: async () => ({ key: "", config: {} }),
  } as unknown as SessionServices;
  const session = new RunSession(
    ctx,
    services,
    { id: runId, chatId: "chat", messageId } as Run,
    { id: botId, slug: "test", name: "Test", model: "test", autonomy: "risky" } as Bot,
    { id: "chat" } as Chat,
  );
  session.memoryGeneration = "1:0:0";
  const ensure = () =>
    (session as unknown as { ensureThread(client: CodexClient): Promise<string> }).ensureThread({
      request,
    } as unknown as CodexClient);
  return { request, ctx, session, ensure, pool };
}
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
});
describe("memory source and workspace boundaries", () => {
  it("does not treat a bot's paraphrase as a verified user statement", async () => {
    const f = fixture();
    f.pool.query.mockResolvedValue({
      rows: [{ text: "Please remember for all teammates: I prefer remote roles." }],
    } as never);
    const memory = new MemoryCoordinator(f.ctx);
    const direct = await memory.actor(f.session, "I prefer remote roles", true);
    expect(direct.verified).toBe(true);
    const inferred = await memory.actor(f.session, "I dislike every office", true);
    expect(inferred.verified).toBe(false);
    expect(inferred.allowShared).toBe(true);
    const ownOnly = await memory.actor(f.session, "I prefer remote roles", false);
    expect(ownOnly.allowShared).toBe(false);
  });
  it("does not grant shared writes for text that came from a website or system-triggered run", async () => {
    const f = fixture();
    const memory = new MemoryCoordinator(f.ctx);
    expect((await memory.actor(f.session, "remote roles", true)).verified).toBe(false);
    expect((await memory.actor(f.session, "remote roles", true)).allowShared).toBe(false);
  });
  it("never overwrites the original Markdown if its initial import fails", async () => {
    const f = fixture();
    const request = vi.fn(async (method: string) => {
      if (method === "fs/readDirectory") return { entries: [{ fileName: "MEMORY.md" }] };
      throw new Error("Read failed");
    });
    vi.mocked(f.ctx.codex.ready).mockResolvedValue({ request } as unknown as CodexClient);
    await expect(new MemoryCoordinator(f.ctx).prepare({ id: botId, slug: "test" })).rejects.toThrow(
      "Read failed",
    );
    expect(request.mock.calls.map((call) => call[0])).not.toContain("fs/writeFile");
  });
  it("keeps saved private content out of the generated shared-computer file", async () => {
    const f = fixture();
    f.pool.query.mockResolvedValue({
      rows: [{ key: `legacy:file:${botId}` }],
      rowCount: 1,
    } as never);
    const request = vi.fn(async () => ({}));
    vi.mocked(f.ctx.codex.ready).mockResolvedValue({ request } as unknown as CodexClient);
    await new MemoryCoordinator(f.ctx).prepare({ id: botId, slug: "test" });
    const args = (request.mock.calls[0] as unknown as [string, { dataBase64: string }])[1];
    expect(Buffer.from(args.dataBase64, "base64").toString()).toContain(
      "file edits are not imported",
    );
    expect(Buffer.from(args.dataBase64, "base64").toString()).not.toContain("## fact");
  });
});
