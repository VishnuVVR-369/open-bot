/**
 * Getting back in after a forgotten password, worded the same on the web and the phone.
 * open-bot sends no email, so there's no reset link: a passkey gets you in and lets you set a new
 * password right after (POST /api/auth/passkey-reset/set-password within the window a passkey
 * sign-in opens), and the reset command on the server works without one.
 */

/** The script behind it is scripts/owner-reset-password.mjs. */
export const RESET_PASSWORD_COMMAND = "pnpm owner:reset-password";

/** The full command, with your email when it's known. */
export function resetPasswordCommand(email?: string | null): string {
  const address = email?.trim();
  return `${RESET_PASSWORD_COMMAND} ${address || "you@example.com"}`;
}

export const RECOVERY_COPY = {
  title: "Forgot your password?",
  intro: "open-bot doesn't send email, so there's no reset link.",
  passkeyHeading: "With a passkey",
  passkeyBody: "Sign in with your passkey, then set a new password. You won't need the old one.",
  serverHeading: "On the server",
  serverBody:
    "Where open-bot runs, open a terminal in its folder and run this. It asks for a new password and signs out every device.",
  passkeyAction: "Sign in with a passkey",
  copyAction: "Copy",
  copied: "Copied",
  close: "Close",
} as const;
