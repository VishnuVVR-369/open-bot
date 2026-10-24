import "server-only";
import { passkey } from "@better-auth/passkey";
import { schema } from "@open-bot/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { count } from "drizzle-orm";
import { db } from "./db";
import { serverEnv } from "./env";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  baseURL: baseUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      passkey: schema.passkey,
    },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  trustedOrigins: [baseUrl, "app://open-bot"],
  plugins: [
    passkey({ rpName: "open-bot", rpID: new URL(baseUrl).hostname, origin: baseUrl }),
    nextCookies(),
  ],
  databaseHooks: {
    user: {
      create: {
        // open-bot belongs to one person: only the owner's email, and only one account.
        before: async (user) => {
          if (!serverEnv.ownerEmail || user.email.toLowerCase() !== serverEnv.ownerEmail) {
            throw new APIError("FORBIDDEN", { message: "This open-bot belongs to someone else." });
          }
          const [{ value }] = await db.select({ value: count() }).from(schema.user);
          if (value > 0)
            throw new APIError("FORBIDDEN", { message: "The owner account already exists." });
          return { data: user };
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
