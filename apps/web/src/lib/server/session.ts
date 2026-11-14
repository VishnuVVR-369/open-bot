import "server-only";
import { schema } from "@open-bot/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { REQUESTED_PAGE_HEADER, signInPath } from "../sign-in-return";
import { auth } from "./auth";
import { db } from "./db";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/**
 * The signed-in owner. Redirects to sign-in (or first-time setup) otherwise, which returns to the
 * page asked for (`proxy.ts` names it, since a layout isn't given the URL).
 */
export async function requireUser() {
  const session = await getSession();
  if (!session) {
    const page = (await headers()).get(REQUESTED_PAGE_HEADER);
    redirect(signInPath(page, (await ownerExists()) ? "/login" : "/setup"));
  }
  return session.user;
}

export async function ownerExists(): Promise<boolean> {
  return (await db.$count(schema.user)) > 0;
}

/** For route handlers: the session, or null. */
export async function sessionOrNull() {
  return getSession();
}
