import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { worker, newTeammate } = h;

  it("schedules: saves a routine and says why a reminder can't be saved", async () => {
    const created = await newTeammate("Mary", "planner");
    const schedule = {
      teammateId: created.id,
      title: "Morning brief",
      prompt: "Brief me",
      cron: "0 9 * * *",
      at: null,
      timezone: null,
    };
    const { id } = await worker.schedules.create(schedule);
    await worker.schedules.setEnabled({ scheduleId: id, enabled: false });
    expect(
      await failure(
        worker.schedules.update({ ...schedule, scheduleId: id, cron: null, at: "2001-01-01" }),
      ),
    ).toEqual({ status: 400, message: "That time is in the past." });
  });

  it("triggers and hooks: a webhook gets a URL, and an unknown one is a 404", async () => {
    const created = await newTeammate("Ida", "watcher");
    const hook = await worker.triggers.create({
      teammateId: created.id,
      kind: "webhook",
      title: "Deploys",
      prompt: "Tell me about deploys",
    });
    expect(hook.hookPath).toMatch(/^\/api\/hooks\/[\w-]+$/);
    const { token } = await worker.triggers.rotateToken({ triggerId: hook.id });
    expect(hook.hookPath).not.toContain(token);
    await worker.triggers.setEnabled({ triggerId: hook.id, enabled: false });
    expect(
      await failure(
        worker.hooks.fire({ token, method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 409, message: "This webhook is paused" });
    expect(
      await failure(
        worker.hooks.fire({ token: "nope", method: "POST", contentType: "", body: "", query: "" }),
      ),
    ).toEqual({ status: 404, message: "Unknown webhook" });
  });
});
