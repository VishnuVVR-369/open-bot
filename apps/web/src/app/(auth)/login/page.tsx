import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, ownerExists } from "@/lib/server/session";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  if (!(await ownerExists())) redirect("/setup");
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Welcome back</h1>
        <p className="text-muted-foreground">Your teammates kept working while you were away.</p>
      </div>
      <AuthForm mode="login" />
    </>
  );
}
