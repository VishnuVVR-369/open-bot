import { settings } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, codexStatus, ctx, worker } = h;

  it("codex: saves where the login comes from, and signs in again", async () => {
    expect(await worker.codex.setAuthSource({ source: "device" })).toEqual(codexStatus);
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    expect(row!.chatgptAuthSource).toBe("device");
    expect(ctx.codex.logout).toHaveBeenCalledOnce();
  });
});
