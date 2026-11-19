import { credentials, settings } from "@open-bot/db";
import { decryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";
import { SettingsService } from "./service";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, worker } = h;

  describe("settings, secrets and email writes", () => {
    const ownerRow = async () => (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const secret = async (kind: "openai_api_key" | "postmark_token") => {
      const [row] = await db.select().from(credentials).where(eq(credentials.kind, kind));
      return row
        ? { secret: decryptSecret(row.encrypted, ctx.env.ENCRYPTION_KEY), hint: row.hint }
        : null;
    };

    it("sets the time zone and the monthly cap, refusing a zone that doesn't exist", async () => {
      await worker.settings.setTimezone({ timezone: "Europe/Paris" });
      await worker.settings.setMonthlyCap({ dollars: 12.345 });
      expect(await ownerRow()).toMatchObject({
        timezone: "Europe/Paris",
        monthlyCapMicros: 12_345_000,
      });
      expect(await failure(worker.settings.setTimezone({ timezone: "Mars/Olympus" }))).toEqual({
        status: 400,
        message: "Unknown timezone.",
      });
      // Before the worker made the row, a change still lands (the web app's update didn't).
      await db.delete(settings);
      await worker.settings.setTimezone({ timezone: "Asia/Kolkata" });
      expect(await ownerRow()).toMatchObject({
        timezone: "Asia/Kolkata",
        monthlyCapMicros: 20_000_000,
      });
    });

    it("keeps model log bodies for a window, or forever, and starts a sweep when it changes", async () => {
      await worker.settings.setModelLogRetention({ days: 30 });
      expect((await ownerRow())?.modelLogRetentionDays).toBe(30);
      await worker.settings.setModelLogRetention({ days: null });
      expect((await ownerRow())?.modelLogRetentionDays).toBeNull();
      for (const days of [0, -1, 3651, 1.5])
        expect(await failure(worker.settings.setModelLogRetention({ days }))).toMatchObject({
          status: 400,
        });
      expect((await ownerRow())?.modelLogRetentionDays).toBeNull();
      // The worker wires the change to the sweep, which runs again with the new window.
      const changed = vi.fn();
      await new SettingsService(ctx, { modelLogRetentionChanged: changed }).setModelLogRetention(7);
      expect(changed).toHaveBeenCalledOnce();
      expect((await ownerRow())?.modelLogRetentionDays).toBe(7);
    });

    it("keeps one encrypted API key, replaced by the next, and removes it", async () => {
      const first = `sk-${"a".repeat(24)}`;
      const second = `sk-${"b".repeat(24)}`;
      await worker.settings.saveApiKey({ apiKey: first });
      await worker.settings.saveApiKey({ apiKey: second });
      expect(await secret("openai_api_key")).toEqual({ secret: second, hint: "sk-…bbbb" });
      expect(await failure(worker.settings.saveApiKey({ apiKey: "nope" }))).toMatchObject({
        status: 400,
      });
      await worker.settings.removeApiKey();
      expect(await secret("openai_api_key")).toBeNull();
    });
  });
});
