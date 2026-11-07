import "server-only";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { schema } from "@open-bot/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { count } from "drizzle-orm";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../password";
import { BASE_URL, passkeyConfig, TRUSTED_ORIGINS } from "./auth-config";
import { db } from "./db";
import { serverEnv } from "./env";

export const auth = betterAuth({
  baseURL: BASE_URL,
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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
  },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  trustedOrigins: TRUSTED_ORIGINS,
  plugins: [
    passkey(passkeyConfig()),
    // The phone app: its requests carry their origin in `expo-origin`.
    expo(),
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
