/** The shortest password the owner's account takes; the web server's auth enforces it. */
export const PASSWORD_MIN_LENGTH = 10;
/** better-auth's default longest password. */
export const PASSWORD_MAX_LENGTH = 128;
/** How long after a passkey sign-in you can set a new password without the current one. */
export const PASSKEY_RESET_MINUTES = 10;

/** What's wrong with a new password typed twice, or null when it can go. */
export function newPasswordProblem({ next, confirm }: { next: string; confirm: string }) {
  if (next.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
  if (next.length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
  if (next !== confirm) return "The new passwords don't match.";
  return null;
}

/** What's wrong with a password change before it's sent, or null when it can go. */
export function passwordChangeProblem({
  current,
  next,
  confirm,
}: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (!current) return "Enter your current password.";
  const problem = newPasswordProblem({ next, confirm });
  if (problem) return problem;
  if (next === current) return "The new password is the same as the current one.";
  return null;
}

/** The server's error code for a failed password change, in plain words, the same on web and phone. */
export function passwordChangeError(code: string | undefined): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That isn't your current password.";
    case "PASSWORD_TOO_SHORT":
      return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
    case "PASSWORD_TOO_LONG":
      return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "This account has no password yet. Confirm with your passkey to set one.";
    case "UNAUTHORIZED":
      return "You were signed out. Sign in again, then change it.";
    case "PASSKEY_REQUIRED":
      return "Your passkey didn't confirm it's you. Try again, and use your fingerprint, face or device PIN when asked.";
    default:
      return "The password wasn't changed. Try again.";
  }
}
