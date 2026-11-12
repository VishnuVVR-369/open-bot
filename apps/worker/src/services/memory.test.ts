import { describe, it, expect, vi } from "vitest";
import type { CodexClient } from "@open-bot/agent";
import type { Context } from "../context";
import type { RunSession } from "../runs/session";
import { MemoryCoordinator } from "./memory";

const teammateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const messageId = "00000000-0000-4000-8000-000000000003";

/** A coordinator whose every database read answers `rows`, for a run that answers a message. */
function fixture() {
  let rows: object[] = [];
  const ctx = {
    db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
    env: {},
    codex: { ready: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context;
  const session = {
    run: { id: runId, messageId },
    bot: { id: teammateId }, // vocabulary: allow (the session's field)
    chat: { id: "chat" },
    memoryGeneration: "1:0:0",
    interrupt: vi.fn(async () => {}),
  } as unknown as RunSession;
  return {
    ctx,
    session,
    memory: new MemoryCoordinator(ctx),
    reads: (next: object[]) => {
      rows = next;
    },
  };
}

describe("memory source and workspace boundaries", () => {
  it("does not absorb a concurrent correction after its own memory write", async () => {
    const f = fixture();
    vi.spyOn(f.memory.store, "generation").mockResolvedValue("2:1:0");
    f.reads([{ cancelRequestedAt: new Date() }]);
    await f.memory.refreshAfterWrite(f.session);
    expect(f.session.interrupt).toHaveBeenCalledOnce();
    expect(f.session.memoryGeneration).toBe("1:0:0");
  });
  it("advances its own memory view only while the run is still current", async () => {
    const f = fixture();
    vi.spyOn(f.memory.store, "generation").mockResolvedValue("1:1:0");
    f.reads([{ cancelRequestedAt: null }]);
    await f.memory.refreshAfterWrite(f.session);
    expect(f.session.interrupt).not.toHaveBeenCalled();
    expect(f.session.memoryGeneration).toBe("1:1:0");
  });
  it("does not treat a teammate's paraphrase as a verified user statement", async () => {
    const f = fixture();
    f.reads([{ text: "Please remember for all teammates: I prefer remote roles." }]);
    const direct = await f.memory.actor(f.session, "I prefer remote roles", true);
    expect(direct.verified).toBe(true);
    const inferred = await f.memory.actor(f.session, "I dislike every office", true);
    expect(inferred.verified).toBe(false);
    expect(inferred.allowShared).toBe(true);
    const ownOnly = await f.memory.actor(f.session, "I prefer remote roles", false);
    expect(ownOnly.allowShared).toBe(false);
  });
  it("does not grant shared writes for text that came from a website or system-triggered run", async () => {
    const f = fixture();
    expect((await f.memory.actor(f.session, "remote roles", true)).verified).toBe(false);
    expect((await f.memory.actor(f.session, "remote roles", true)).allowShared).toBe(false);
  });
  it("never overwrites the original Markdown if its initial import fails", async () => {
    const f = fixture();
    const request = vi.fn(async (method: string) => {
      if (method === "fs/readDirectory") return { entries: [{ fileName: "MEMORY.md" }] };
      throw new Error("Read failed");
    });
    vi.mocked(f.ctx.codex.ready).mockResolvedValue({ request } as unknown as CodexClient);
    await expect(f.memory.prepare({ id: teammateId, slug: "test" })).rejects.toThrow("Read failed");
    expect(request.mock.calls.map((call) => call[0])).not.toContain("fs/writeFile");
  });
  it("keeps saved private content out of the generated shared-computer file", async () => {
    const f = fixture();
    f.reads([{ key: `legacy:file:${teammateId}` }]);
    const request = vi.fn(async () => ({}));
    vi.mocked(f.ctx.codex.ready).mockResolvedValue({ request } as unknown as CodexClient);
    await f.memory.prepare({ id: teammateId, slug: "test" });
    const args = (request.mock.calls[0] as unknown as [string, { dataBase64: string }])[1];
    expect(Buffer.from(args.dataBase64, "base64").toString()).toContain(
      "file edits are not imported",
    );
    expect(Buffer.from(args.dataBase64, "base64").toString()).not.toContain("## fact");
  });
});
