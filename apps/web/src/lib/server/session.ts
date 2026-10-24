import "server-only";
import { schema } from "@open-bot/db";
import { count } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { db } from "./db";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/** The signed-in owner. Redirects to sign-in (or first-time setup) otherwise. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect((await ownerExists()) ? "/login" : "/setup");
  return session.user;
}

export async function ownerExists(): Promise<boolean> {
  const [{ value }] = await db.select({ value: count() }).from(schema.user);
  return value > 0;
}

/** For route handlers: the session, or null. */
export async function sessionOrNull() {
  return getSession();
}
