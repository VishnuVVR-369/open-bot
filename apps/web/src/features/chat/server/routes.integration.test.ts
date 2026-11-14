import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { ORPCError } from "@orpc/client";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { ids, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("says what's wrong with refused input in the schema's words", async () => {
    await expect(api.chats.rename({ chatId: ids.chat, title: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Name the chat.",
      data: { issues: [expect.objectContaining({ path: ["title"] })] },
    });
  });

  it("answers a failed query with the database's error, never its SQL or parameters", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Postgres refuses a NUL byte in text, so the search fails with the query as a parameter.
      const failed = await api.search.messages({ query: "a private\u0000phrase" }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ORPCError);
      expect(failed).toMatchObject({
        status: 500,
        message: "The database refused the query (SQLSTATE 22021).",
      });
      expect(logged).toHaveBeenCalledOnce();
      expect(logged.mock.calls[0]![1]).toMatchObject({ code: "22021", query: expect.any(String) });
      expect(inspect(logged.mock.calls, { depth: 6 })).not.toContain("private");
    } finally {
      logged.mockRestore();
    }
  });

  it("passes chat and run changes to the worker, and keeps a reused message id a CONFLICT", async () => {
    const chatId = ids.chat;
    const runId = randomUUID();
    const teammateId = ids.teammate;
    const message = {
      id: randomUUID(),
      role: "user",
      text: "Hi",
      attachments: [],
      mentions: [],
      steeredRunId: null,
      redoOfRunId: null,
      createdAt: new Date().toISOString(),
    };
    const send = { clientId: randomUUID(), chatId, text: "Hi", attachments: [], mentions: [] };
    const feedback = { runId, text: "Shorter.", remember: true, redo: { clientId: randomUUID() } };
    const ok = { status: 200, body: { ok: true } };
    const created = { status: 200, body: { chatId } };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/chats/direct",
        () => api.chats.newDirect({ botId: teammateId }),
        { teammateId },
        created,
      ],
      [
        "/internal/chats/group",
        () => api.chats.createGroup({ title: "Launch", botIds: [teammateId, runId] }),
        { title: "Launch", teammateIds: [teammateId, runId] },
        created,
      ],
      [
        `/internal/chats/${chatId}/rename`,
        () => api.chats.rename({ chatId, title: "R" }),
        { title: "R" },
        ok,
      ],
      [`/internal/chats/${chatId}/archive`, () => api.chats.archive({ chatId }), {}, ok],
      [`/internal/chats/${chatId}/main`, () => api.chats.makeMain({ chatId }), {}, ok],
      [`/internal/chats/${chatId}/read`, () => api.chats.markRead({ chatId }), {}, ok],
      [
        `/internal/chats/${chatId}/messages`,
        () => api.chats.send(send),
        { clientId: send.clientId, text: "Hi", attachments: [], mentions: [] },
        { status: 200, body: message },
      ],
      [`/internal/runs/${runId}/stop`, () => api.runs.cancel({ runId }), {}, ok],
      [
        `/internal/runs/${runId}/rate`,
        () => api.runs.rate({ runId, rating: "up" }),
        { rating: "up" },
        ok,
      ],
      [
        `/internal/runs/${runId}/feedback`,
        () => api.runs.feedback(feedback),
        { text: feedback.text, remember: true, redo: feedback.redo },
        ok,
      ],
    ];
    for (const [path, , , answer] of calls) answers.set(path, answer);
    try {
      for (const [path, call, body] of calls) {
        await call();
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      expect(await api.chats.send(send)).toEqual(message);
      // A reused id is the contract's CONFLICT, which the composer tells apart from a stale edit.
      const reused = {
        status: 409,
        body: { error: "That message id was already used for another message.", code: "CONFLICT" },
      };
      answers.set(`/internal/chats/${chatId}/messages`, reused);
      answers.set(`/internal/runs/${runId}/feedback`, reused);
      for (const call of [() => api.chats.send(send), () => api.runs.feedback(feedback)])
        await expect(call()).rejects.toMatchObject({
          code: "CONFLICT",
          message: "That message id was already used for another message.",
        });
      answers.set(`/internal/runs/${runId}/stop`, {
        status: 404,
        body: { error: "That reply is gone.", code: "NOT_FOUND" },
      });
      await expect(api.runs.cancel({ runId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That reply is gone.",
      });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });
});
