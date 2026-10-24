"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const router = useRouter();
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(form: FormData) {
    setPending("password");
    setError(null);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const result =
      mode === "setup"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(form.get("name") ?? "").trim() || "You",
          })
        : await authClient.signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "That didn't work. Check your email and password.");
      setPending(null);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  async function onPasskey() {
    setPending("passkey");
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setError(result.error.message ?? "Passkey sign-in was cancelled.");
      setPending(null);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={onSubmit} className="flex flex-col gap-4">
        {mode === "setup" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              placeholder="What your teammates call you"
              required
            />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus={mode === "login"}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            minLength={10}
            required
          />
          {mode === "setup" && (
            <p className="text-xs text-muted-foreground">
              At least 10 characters. You can add a passkey later.
            </p>
          )}
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/8 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={pending !== null}>
          {pending === "password" && <Loader2 className="animate-spin" />}
          {mode === "setup" ? "Create account" : "Sign in"}
        </Button>
      </form>
      {mode === "login" && (
        <Button variant="outline" size="lg" onClick={onPasskey} disabled={pending !== null}>
          {pending === "passkey" ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Sign in with a passkey
        </Button>
      )}
    </div>
  );
}
