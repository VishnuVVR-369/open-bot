import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { services, worker } = h;

  it("teammates: creates, edits, and refuses an edit made from a stale copy", async () => {
    const created = await worker.teammates.create({ name: "Grace", role: "engineer" });
    expect(created).toMatchObject({ name: "Grace", chatPath: `/chats/${created.chatId}` });
    const teammateId = created.botId;
    const updated = await worker.teammates.update({
      teammateId,
      changes: { role: "staff engineer" },
      expected_revision: created.revision,
    });
    expect(updated.revision).not.toBe(created.revision);
    expect(
      await failure(
        worker.teammates.update({
          teammateId,
          changes: { role: "manager" },
          expected_revision: created.revision,
        }),
      ),
    ).toMatchObject({ status: 409 });
    await worker.teammates.sync({ teammateId });
    expect(services.executor.syncWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: teammateId }),
    );
    expect(await failure(worker.teammates.sync({ teammateId: ID }))).toEqual({
      status: 404,
      message: "No such teammate.",
    });
  });
});
