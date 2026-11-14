import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, ownerExists } from "@/lib/server/session";
import { NEXT_PARAM, safeNext, signInPath } from "@/lib/sign-in-return";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const value = (await searchParams)[NEXT_PARAM];
  const next = safeNext(typeof value === "string" ? value : null);
  if (await getSession()) redirect(next);
  if (!(await ownerExists())) redirect(signInPath(next, "/setup"));
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold">Welcome back</h1>
        <p className="text-[14.5px] text-muted-foreground">
          Your teammates kept working while you were away.
        </p>
      </div>
      <AuthForm mode="login" next={next} />
    </>
  );
}
