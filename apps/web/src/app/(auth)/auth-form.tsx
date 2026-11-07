"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

/** The command that sets a new owner password from the server; scripts/owner-reset-password.mjs. */
const RESET_COMMAND = "pnpm owner:reset-password";

/**
 * There's no email to send a reset link with, so this says the two ways back in: a passkey,
 * then a new password in Settings, or the reset command on the server open-bot runs on.
 */
function ForgotPassword({ onPasskey, disabled }: { onPasskey: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-sm text-[13px] text-muted-foreground underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
        >
          Forgot password?
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Forgot your password?</DialogTitle>
          <DialogDescription>
            open-bot doesn&apos;t send email, so there&apos;s no reset link. There are two ways back
            in.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4 text-[14px]">
          <li className="flex flex-col gap-1">
            <span className="font-medium">With a passkey</span>
            <span className="text-muted-foreground">
              Sign in with it, then set a new password in Settings, under Security.
            </span>
          </li>
          <li className="flex flex-col gap-1.5">
            <span className="font-medium">On the server</span>
            <span className="text-muted-foreground">
              Where open-bot runs, open a terminal in its folder and run this with your email. It
              asks for a new password and signs out every device.
            </span>
            <code className="rounded-lg border bg-subtle px-3 py-2 font-mono text-[12.5px] break-all">
              {RESET_COMMAND} you@example.com
            </code>
          </li>
        </ol>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              onPasskey();
            }}
            disabled={disabled}
          >
            <KeyRound />
            Sign in with a passkey
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            {mode === "login" && (
              <ForgotPassword onPasskey={() => void onPasskey()} disabled={pending !== null} />
            )}
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
          {mode === "setup" && (
            <p className="text-xs text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters. You can add a passkey later.
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
