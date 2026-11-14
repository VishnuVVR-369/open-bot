import { randomUUID } from "node:crypto";
import { memoryItems, messages, runs } from "@open-bot/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { REUSED_ID } from "../features/chat";
import { rpcEnabled, rpcHarness, failure, ID } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, executor, services, worker, newTeammate, teammateWithRun } = h;

  it("messages and runs: dispatches, retries once however often asked, and cancels", async () => {
    await worker.messages.dispatch({ messageId: ID });
    expect(services.executor.dispatchMessage).toHaveBeenLastCalledWith(ID);
    const { run } = await teammateWithRun();
    const [first, again] = await Promise.all([
      worker.runs.retry({ runId: run.id }),
      worker.runs.retry({ runId: run.id }),
    ]);
    expect(first.runId).not.toBe(run.id);
    expect(again).toEqual(first);
    expect(await failure(worker.runs.retry({ runId: first.runId }))).toEqual({
      status: 409,
      message: "That run is still going.",
    });
    await worker.runs.processCancellations();
    expect(services.executor.processCancellations).toHaveBeenCalled();
  });
  describe("chat and run writes", () => {
    it("saves a sent message once, delivers it, and refuses a reused id or a file not uploaded", async () => {
      const { chatId } = await newTeammate("Cy", "analyst");
      const send = { clientId: randomUUID(), chatId, text: " Hi ", attachments: [], mentions: [] };
      const sent = await worker.chats.send(send);
      expect(sent).toMatchObject({ role: "user", text: "Hi", redoOfRunId: null });
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(sent.id);
      // A retry gets the same message, and asks for delivery again.
      executor.dispatchMessage.mockClear();
      expect((await worker.chats.send(send)).id).toBe(sent.id);
      expect(executor.dispatchMessage).toHaveBeenCalledWith(sent.id);
      expect(await db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(1);
      expect(await failure(worker.chats.send({ ...send, text: "Other" }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
      // Saving is what counts: a delivery that fails is left to the reconciler.
      executor.dispatchMessage.mockRejectedValueOnce(new Error("busy"));
      const later = await worker.chats.send({ ...send, clientId: randomUUID(), text: "Later" });
      expect(later.text).toBe("Later");
      expect(ctx.log.warn).toHaveBeenCalledWith(
        "dispatch deferred to the reconciler",
        expect.objectContaining({ messageId: later.id }),
      );

      const fresh = { ...send, clientId: randomUUID() };
      expect(await failure(worker.chats.send({ ...fresh, text: " " }))).toEqual({
        status: 400,
        message: "Write a message first.",
      });
      expect(await failure(worker.chats.send({ ...fresh, chatId: ID }))).toEqual({
        status: 404,
        message: "That chat no longer exists.",
      });
      const attachment = {
        path: "/home/bot/uploads/never/notes.txt",
        name: "notes.txt",
        mime: "text/plain",
        size: 3,
      };
      expect(await failure(worker.chats.send({ ...fresh, attachments: [attachment] }))).toEqual({
        status: 400,
        message: "notes.txt didn't finish uploading. Attach it again.",
      });
      expect(await db.select().from(messages).where(eq(messages.clientId, fresh.clientId))).toEqual(
        [],
      );
    });

    it("stops and rates a run, and takes feedback once per redo id", async () => {
      const { created, run } = await teammateWithRun();
      await worker.runs.stop({ runId: run.id });
      const stopped = async () => (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
      expect((await stopped()).cancelRequestedAt).not.toBeNull();
      expect(executor.processCancellations).toHaveBeenCalled();
      await worker.runs.rate({ runId: run.id, rating: "up" });
      expect((await stopped()).rating).toBe("up");
      for (const call of [
        () => worker.runs.stop({ runId: ID }),
        () => worker.runs.rate({ runId: ID, rating: null }),
        () => worker.runs.feedback({ runId: ID, text: "No", remember: false, redo: null }),
      ])
        expect(await failure(call())).toEqual({ status: 404, message: "That reply is gone." });

      await worker.runs.feedback({
        runId: run.id,
        text: "Cite sources.",
        remember: true,
        redo: null,
      });
      expect((await stopped()).rating).toBe("down");
      const kept = await db
        .select({ content: memoryItems.content })
        .from(memoryItems)
        .where(and(eq(memoryItems.teammateId, created.id), eq(memoryItems.kind, "lesson")));
      expect(kept).toEqual([{ content: "Cite sources." }]);
      // A lesson memory refuses is the owner's to fix, not the worker's failure.
      expect(
        await failure(
          worker.runs.feedback({ runId: run.id, text: "No", remember: true, redo: null }),
        ),
      ).toMatchObject({ status: 400 });

      await worker.runs.rate({ runId: run.id, rating: null });
      const redo = { clientId: randomUUID() };
      const feedback = { runId: run.id, text: "Shorter.", remember: false, redo };
      await worker.runs.feedback(feedback);
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.clientId, redo.clientId));
      expect(message).toMatchObject({
        chatId: created.chatId,
        text: "Shorter.",
        redoOfRunId: run.id,
        feedbackRequest: { text: "Shorter.", remember: false },
      });
      expect((await stopped()).rating).toBe("down");
      expect(executor.dispatchMessage).toHaveBeenLastCalledWith(message!.id);
      // The same feedback again delivers the saved message; other feedback with its id is refused.
      await worker.runs.feedback(feedback);
      expect(await db.select().from(messages).where(eq(messages.redoOfRunId, run.id))).toHaveLength(
        1,
      );
      expect(await failure(worker.runs.feedback({ ...feedback, text: "Longer." }))).toEqual({
        status: 409,
        message: REUSED_ID,
      });
    });
  });
});
