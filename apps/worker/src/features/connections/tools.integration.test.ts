import { describe, expect, it } from "vitest";
import { connections } from "@open-bot/db";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { db, service, requestAction, fixture, call } = toolHarness();

  it("does not expose credentials and requires approval for connection access even in full auto", async () => {
    const { session } = await fixture();
    const target = await service.create({ name: "Researcher", role: "researcher" });
    const [row] = await db
      .insert(connections)
      .values({
        name: "github",
        label: "GitHub",
        transport: "http",
        url: "https://example.com/mcp",
        encrypted: "do-not-expose",
        secretNames: ["Authorization"],
        botIds: [session.bot.id],
      })
      .returning();
    const listed = await call(session, "list_bot_connections");
    expect(listed.text).not.toContain("do-not-expose");
    expect(listed.text).not.toContain("Authorization");
    const input = {
      bot_id: target.botId,
      connection_id: row!.id,
      assigned: true,
      expected_revision: listed.json()[0].revision,
    };
    requestAction.mockResolvedValueOnce("denied");
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(false);
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(true);
    expect(requestAction).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ askEveryTime: true }),
    );
    expect((await service.get(target.botId)).connections).toHaveLength(1);
    expect((await call(session, "set_bot_connection", input)).response.success).toBe(false);
    const latest = (await service.listConnections())[0]!;
    requestAction.mockClear();
    const again = await call(session, "set_bot_connection", {
      ...input,
      expected_revision: latest.revision,
    });
    expect(again.json().unchanged).toContain("can already use GitHub");
    expect(requestAction).not.toHaveBeenCalled();
    expect(
      (
        await call(session, "set_bot_connection", {
          ...input,
          assigned: false,
          expected_revision: latest.revision,
        })
      ).response.success,
    ).toBe(true);
    expect((await service.get(target.botId)).connections).toHaveLength(0);
  });
});
