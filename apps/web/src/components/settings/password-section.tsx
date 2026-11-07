"use client";

import { RECOVERY_COPY, resetPasswordCommand } from "@open-bot/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { useAppState } from "@/lib/client/queries";
import {
  newPasswordProblem,
  PASSWORD_MIN_LENGTH,
  passwordChangeError,
  passwordChangeProblem,
} from "@open-bot/shared";
import { CopyCommand } from "@/components/copy-command";
import { PasswordInput } from "@/components/password-input";

type Mode = "change" | "reset";

function Field({
  id,
  label,
  autoComplete,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <PasswordInput
        id={id}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        required
      />
      {hint && (
        <p id={`${id}-hint`} className="text-[12.5px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The sign-in password. Change it with the current one, or, when that's forgotten, set a new one
 * after confirming with a passkey: right after a passkey sign-in no prompt is needed, otherwise
 * the passkey is asked for on save. Either way every other device is signed out.
 */
export function PasswordSection({ startWithReset = false }: { startWithReset?: boolean }) {
  const { data: state } = useAppState();
  const passkeys = authClient.useListPasskeys();
  const hasPasskey = (passkeys.data?.length ?? 0) > 0;
  const [chosen, setMode] = useState<Mode>(startWithReset ? "reset" : "change");
  // Without a passkey there's nothing to confirm with, so it's the current password or the command.
  const mode: Mode = chosen === "reset" && passkeys.data?.length === 0 ? "change" : chosen;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Right after a passkey sign-in, the passkey doesn't need asking for again.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (startWithReset) setMode("reset");
  }, [startWithReset]);
  useEffect(() => {
    if (mode !== "reset") return;
    let live = true;
    void authClient.passkeyReset.status().then((result) => {
      if (live) setReady(Boolean(result.data?.ready));
    });
    return () => {
      live = false;
    };
  }, [mode]);

  function switchTo(value: Mode) {
    setMode(value);
    setError(null);
    setCurrent("");
  }

  function done(message: string) {
    setCurrent("");
    setNext("");
    setConfirm("");
    setReady(false);
    setMode("change");
    toast(message, {
      description: "Your other devices, the phone app included, were signed out.",
    });
  }

  async function change() {
    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) return setError(problem);
    setPending(true);
    setError(null);
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (result.error) return setError(passwordChangeError(result.error.code));
    done("Password changed");
  }

  async function reset() {
    const problem = newPasswordProblem({ next, confirm });
    if (problem) return setError(problem);
    setPending(true);
    setError(null);
    if (!ready) {
      const signIn = await authClient.signIn.passkey();
      if (signIn?.error) {
        setPending(false);
        return setError("The passkey wasn't confirmed, so nothing changed.");
      }
    }
    const result = await authClient.passkeyReset.setPassword({ newPassword: next });
    setPending(false);
    if (result.error) {
      setReady(false);
      return setError(passwordChangeError(result.error.code));
    }
    done("New password set");
  }

  return (
    <form
      id="set-password"
      className="flex scroll-mt-8 flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5"
      data-testid="change-password"
      onSubmit={(event) => {
        event.preventDefault();
        void (mode === "change" ? change() : reset());
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
      {mode === "reset" && (
        <div className="flex items-start gap-3" data-testid="passkey-reset-note">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
            <KeyRound className="size-4" />
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium">Set a new password</span>
            <span className="text-[13px] text-muted-foreground">
              {ready ? RECOVERY_COPY.resetReadyNote : RECOVERY_COPY.resetConfirmNote}
            </span>
          </div>
        </div>
      )}
      <div className="flex max-w-[420px] flex-col gap-4">
        {mode === "change" && (
          <Field
            id="current-password"
            label="Current password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
          />
        )}
        <Field
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        />
        <Field
          id="confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
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
          {pending ? (
            <Loader2 className="animate-spin" />
          ) : (
            mode === "reset" && !ready && <KeyRound />
          )}
          {mode === "change"
            ? "Change password"
            : ready
              ? "Set new password"
              : "Confirm with passkey and save"}
        </Button>
        <span className="text-[12.5px] text-muted-foreground">Signs out your other devices.</span>
      </div>
      <div
        className="-mx-4 -mb-4 flex flex-col gap-2 border-t px-4 py-3.5 text-[13px] text-muted-foreground sm:-mx-5 sm:-mb-5 sm:px-5"
        data-testid="forgot-password"
      >
        {mode === "reset" ? (
          <button
            type="button"
            onClick={() => switchTo("change")}
            className="w-fit rounded-sm font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
          >
            {RECOVERY_COPY.useCurrentPassword}
          </button>
        ) : hasPasskey ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span>{RECOVERY_COPY.settingsForgot}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => switchTo("reset")}
              data-testid="use-passkey-instead"
            >
              <KeyRound />
              {RECOVERY_COPY.resetAction}
            </Button>
          </div>
        ) : (
          <>
            <p>
              <span className="font-medium text-foreground/80">{RECOVERY_COPY.settingsForgot}</span>{" "}
              {RECOVERY_COPY.settingsNoPasskey}
            </p>
            <p className="mt-1.5 font-medium text-foreground/80">
              {RECOVERY_COPY.otherWaysHeading}
            </p>
            <p>{RECOVERY_COPY.serverBody}</p>
            <CopyCommand command={resetPasswordCommand(state?.user.email)} />
          </>
        )}
      </div>
    </form>
  );
}
