import { credentials } from "@open-bot/db";
import { decryptSecret } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, ctx, worker, newTeammate } = h;

  describe("settings, secrets and email writes", () => {
    const secret = async (kind: "openai_api_key" | "postmark_token") => {
      const [row] = await db.select().from(credentials).where(eq(credentials.kind, kind));
      return row
        ? { secret: decryptSecret(row.encrypted, ctx.env.ENCRYPTION_KEY), hint: row.hint }
        : null;
    };

    it("makes the email row once, saves the domain and token, and keeps the token when left empty", async () => {
      const first = await worker.email.status();
      expect(first).toMatchObject({ domain: null, tokenHint: null, addresses: [] });
      expect(first.inboundPath).toMatch(/^\/api\/inbound\/email\/[\w-]{24}$/);
      expect((await worker.email.status()).inboundPath).toBe(first.inboundPath);

      const token = "postmark-token-0123456789";
      await worker.email.save({ domain: "https://www.Team.Example.com/", token });
      await newTeammate("Mailer", "writes email");
      const saved = await worker.email.status();
      expect(saved).toMatchObject({ domain: "team.example.com", tokenHint: "pos…6789" });
      expect(saved.addresses).toContainEqual(
        expect.objectContaining({
          name: "Mailer",
          address: expect.stringMatching(/@team\.example\.com$/),
        }),
      );
      expect(await secret("postmark_token")).toMatchObject({ secret: token });

      await worker.email.save({ domain: "team.example.com", token: "" });
      expect(await secret("postmark_token")).toMatchObject({ secret: token });
      expect(await failure(worker.email.save({ domain: "not a domain", token: "" }))).toEqual({
        status: 400,
        message: "Give a domain, like team.example.com.",
      });
      expect(await failure(worker.email.save({ domain: "", token: "short" }))).toEqual({
        status: 400,
        message: "That doesn't look like a Postmark server token.",
      });
      expect((await worker.email.status()).domain).toBe("team.example.com");

      await worker.email.removeToken();
      expect(await secret("postmark_token")).toBeNull();
      await worker.email.save({ domain: "", token: "" });
      expect(await worker.email.status()).toMatchObject({ domain: null, tokenHint: null });
    });
  });
});
