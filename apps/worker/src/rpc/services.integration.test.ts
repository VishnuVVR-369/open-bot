import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { ctx, operation, services, worker, newTeammate } = h;

  it("screens, takeovers and screen operations: reach the computer for a real teammate", async () => {
    const created = await newTeammate("Linus", "operator");
    await worker.screens.wake({ screenId: created.id });
    expect(ctx.computer.startScreen).toHaveBeenLastCalledWith(created.id);
    expect(await failure(worker.screens.wake({ screenId: ID }))).toMatchObject({ status: 404 });
    expect(await worker.takeovers.codeContext({ takeoverId: ID })).toEqual({
      screenId: ID,
      site: "example.com",
    });
    await worker.takeovers.dismiss({ takeoverId: ID });
    expect(await worker.screenOperations.cancel({ operationId: ID })).toEqual(operation);
  });

  it("email, connections, swarms, telegram and egress: reach their services", async () => {
    expect(
      await worker.email.inbound({ params: { token: "inbound-token" }, body: { Subject: "Hi" } }),
    ).toEqual({ ok: true, botId: null });
    expect(services.email.inbound).toHaveBeenLastCalledWith("inbound-token", { Subject: "Hi" });
    expect(await worker.connections.test({ connectionId: ID })).toMatchObject({ ok: true });
    await worker.swarms.stop({ swarmId: ID });
    expect(services.swarms.stop).toHaveBeenLastCalledWith(ID);
    expect(await worker.telegram.status()).toMatchObject({ connected: false });
    await worker.egress.setMode({ mode: "prefer" });
    expect(services.egress.setMode).toHaveBeenLastCalledWith("prefer");
    expect(await failure(worker.egress.setMode({ mode: "sometimes" as "off" }))).toMatchObject({
      status: 400,
    });
  });
});
