import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, ownerExists } from "@/lib/server/session";
import { NEXT_PARAM, safeNext, signInPath } from "@/lib/sign-in-return";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Set up" };

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  const value = (await searchParams)[NEXT_PARAM];
  const next = safeNext(typeof value === "string" ? value : null);
  if (await getSession()) redirect(next);
  if (await ownerExists()) redirect(signInPath(next));
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold">Set up open-bot</h1>
        <p className="text-[14.5px] text-muted-foreground">
          Create the owner account. Only the email configured as{" "}
          <code className="font-mono text-[13px]">OWNER_EMAIL</code> can sign up, and only once.
        </p>
      </div>
      <AuthForm mode="setup" next={next} />
    </>
  );
}
