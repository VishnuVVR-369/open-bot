import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, ownerExists } from "@/lib/server/session";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Set up" };

export default async function SetupPage() {
  if (await getSession()) redirect("/");
  if (await ownerExists()) redirect("/login");
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Set up open-bot</h1>
        <p className="text-muted-foreground">
          Create the owner account. Only the email configured as{" "}
          <code className="font-mono text-[13px]">OWNER_EMAIL</code> can sign up, and only once.
        </p>
      </div>
      <AuthForm mode="setup" />
    </>
  );
}
