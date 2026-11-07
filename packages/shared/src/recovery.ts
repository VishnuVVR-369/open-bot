import { PASSKEY_RESET_MINUTES } from "./password";

/**
 * Getting back in after a forgotten password, worded the same on the web and the phone.
 * open-bot sends no email, so there's no reset link: a passkey gets you in and lets you set a new
 * password right after (POST /api/auth/passkey-reset/set-password within the window a passkey
 * sign-in opens), and the reset command on the server works without one.
 * The passkey is the short path, so it always comes first; the command sits under "Other ways".
 */

/** The script behind it is scripts/ops/owner-reset-password.mjs. */
export const RESET_PASSWORD_COMMAND = "pnpm owner:reset-password";

/** The full command, with your email when it's known. */
export function resetPasswordCommand(email?: string | null): string {
  const address = email?.trim();
  return `${RESET_PASSWORD_COMMAND} ${address || "you@example.com"}`;
}

export const RECOVERY_COPY = {
  title: "Forgot your password?",
  /** The lead, right above the passkey button. */
  passkeyHeading: "Use a passkey to reset your password.",
  passkeyAction: "Sign in with a passkey",
  /** Right under the passkey button. */
  passkeyNote: `After you sign in, you have ${PASSKEY_RESET_MINUTES} minutes to choose a new password.`,
  otherWaysHeading: "Other ways",
  serverBody:
    "Where open-bot runs, open a terminal in its folder and run this. It asks for a new password and signs out every device.",
  noEmailNote: "open-bot doesn't send email, so there's no reset link.",
  copyAction: "Copy",
  copied: "Copied",
  close: "Close",

  /** Settings > Security, under the change-password form. */
  settingsForgot: "Forgot your password?",
  /** The direct action there, when you have a passkey. */
  resetAction: "Reset with a passkey",
  /** There, when you have no passkey yet. */
  settingsNoPasskey: "Add a passkey below and you can reset it from here.",
  /** The reset form's note, right after a passkey sign-in. */
  resetReadyNote: `You signed in with your passkey, so you don't need the old password. This works for ${PASSKEY_RESET_MINUTES} minutes after signing in.`,
  /** The reset form's note otherwise: the passkey is asked for on save. */
  resetConfirmNote:
    "Your passkey confirms it's you, so you don't need the old password. You'll be asked for it when you save.",
  /** Leaves the reset form for the usual change with the current password. */
  useCurrentPassword: "Use your current password instead",
} as const;
