"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { useAppState } from "@/lib/client/queries";
import { PASSWORD_MIN_LENGTH, passwordChangeError, passwordChangeProblem } from "@/lib/password";

/**
 * Change the sign-in password: the current one, then the new one twice. Goes through
 * better-auth's own change-password call, which also signs out every other device.
 */
export function PasswordSection() {
  const { data: state } = useAppState();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (result.error) {
      setError(passwordChangeError(result.error.code));
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    toast("Password changed", {
      description: "Your other devices, the phone app included, were signed out.",
    });
  }

  return (
    <form
      className="flex max-w-md flex-col gap-4 rounded-xl bg-card px-4 py-4 shadow-raised"
      data-testid="change-password"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* Lets a password manager tell which account the new password belongs to. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={state?.user.email ?? ""}
        readOnly
        hidden
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          value={next}
          onChange={(event) => setNext(event.target.value)}
          aria-describedby="new-password-hint"
          required
        />
        <p id="new-password-hint" className="text-[12.5px] text-muted-foreground">
          At least {PASSWORD_MIN_LENGTH} characters.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm-password">New password again</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Change password
        </Button>
        <span className="text-[12.5px] text-muted-foreground">Signs out your other devices.</span>
      </div>
    </form>
  );
}
