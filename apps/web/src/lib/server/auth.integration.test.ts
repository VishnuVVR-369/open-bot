import { inspect } from "node:util";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = testDatabaseServer();

/** Better Auth against a disposable database, with the logger the app gives it. */
describe.skipIf(!url)("Better Auth's log", () => {
  const database = testDatabase(url);
  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    // Only the owner may sign up, so the sign-up below gets as far as writing the user.
    process.env.OWNER_EMAIL = "private@example.test";
  });
  afterAll(async () => {
    const { pool } = await import("./db");
    await pool.end();
    await database.drop();
  });

  it("never records a failed sign-up's name or email", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { auth } = await import("./auth");
      // Postgres refuses a NUL byte in text, so creating the user fails with both as parameters.
      await expect(
        auth.api.signUpEmail({
          body: {
            name: "Private\u0000Name",
            email: "private@example.test",
            password: "a-long-test-password",
          },
        }),
      ).rejects.toThrow();
      expect(logged).toHaveBeenCalled();
      const lines = inspect(logged.mock.calls, { depth: 6 });
      expect(lines).toContain("SQLSTATE 22021");
      expect(lines).not.toMatch(/private/i);
    } finally {
      logged.mockRestore();
    }
  });
});
