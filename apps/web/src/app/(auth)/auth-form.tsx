"use client";

import { RECOVERY_COPY, resetPasswordCommand } from "@open-bot/shared";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ComponentProps } from "react";
import { CopyCommand } from "@/components/copy-command";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH } from "@open-bot/shared";

/** Where a passkey sign-in from "Forgot password?" lands: the form for a new password. */
const SET_PASSWORD = "/settings#set-password";

/**
 * There's no email to send a reset link with, so this says the two ways back in: a passkey,
 * which also lets you set a new password right after, or the reset command on the server.
 */
function ForgotPassword({
  email,
  onPasskey,
  disabled,
}: {
  email: string;
  onPasskey: () => void;
  disabled: boolean;
}) {
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
      <DialogContent className="gap-5 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{RECOVERY_COPY.title}</DialogTitle>
          <DialogDescription>{RECOVERY_COPY.intro}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 text-[14px]">
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">{RECOVERY_COPY.passkeyHeading}</h3>
            <p className="text-muted-foreground">{RECOVERY_COPY.passkeyBody}</p>
          </section>
          <section className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <h3 className="font-medium">{RECOVERY_COPY.serverHeading}</h3>
              <p className="text-muted-foreground">{RECOVERY_COPY.serverBody}</p>
            </div>
            <CopyCommand command={resetPasswordCommand(email)} />
          </section>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{RECOVERY_COPY.close}</Button>
          </DialogClose>
          <Button
            onClick={() => {
              setOpen(false);
              onPasskey();
            }}
            disabled={disabled}
          >
            <KeyRound />
            {RECOVERY_COPY.passkeyAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A password field with a button that shows what you typed. */
function PasswordInput({
  mode,
  ...props
}: { mode: "login" | "setup" } & ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoComplete={mode === "setup" ? "new-password" : "current-password"}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/12"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const router = useRouter();
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  async function onSubmit(form: FormData) {
    setPending("password");
    setError(null);
    const address = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const result =
      mode === "setup"
        ? await authClient.signUp.email({
            email: address,
            password,
            name: String(form.get("name") ?? "").trim() || "You",
          })
        : await authClient.signIn.email({ email: address, password });
    if (result.error) {
      setError(result.error.message ?? "That didn't work. Check your email and password.");
      setPending(null);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  /** Signs in with a passkey, then goes home, or to setting a new password. */
  async function onPasskey(next = "/") {
    setPending("passkey");
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setError(result.error.message ?? "Passkey sign-in was cancelled.");
      setPending(null);
      return;
    }
    router.replace(next);
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
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoFocus={mode === "login"}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            {mode === "login" && (
              <ForgotPassword
                email={email}
                onPasskey={() => void onPasskey(SET_PASSWORD)}
                disabled={pending !== null}
              />
            )}
          </div>
          <PasswordInput
            mode={mode}
            id="password"
            name="password"
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
        <Button
          variant="outline"
          size="lg"
          onClick={() => void onPasskey()}
          disabled={pending !== null}
        >
          {pending === "passkey" ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Sign in with a passkey
        </Button>
      )}
    </div>
  );
}
