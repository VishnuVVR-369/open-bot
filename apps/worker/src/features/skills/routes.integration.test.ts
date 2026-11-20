import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { worker } = h;

  it("skills: saves one, and says why a name can't be used", async () => {
    const { id } = await worker.skills.save({
      name: "weekly-report",
      description: "Write the weekly report",
      instructions: "Summarize the week",
      teammateId: null,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await failure(
        worker.skills.save({ name: "page", description: "x", instructions: "y", teammateId: null }),
      ),
    ).toEqual({ status: 400, message: "That name belongs to a built-in skill. Pick another." });
    await worker.skills.remove({ skillId: id });
  });
});
