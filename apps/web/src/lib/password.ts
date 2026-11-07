/** The shortest password the owner's account takes; lib/server/auth.ts enforces it. */
export const PASSWORD_MIN_LENGTH = 10;
/** better-auth's default longest password. */
export const PASSWORD_MAX_LENGTH = 128;

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
  if (next.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
  if (next.length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
  if (next !== confirm) return "The new passwords don't match.";
  if (next === current) return "The new password is the same as the current one.";
  return null;
}

/** better-auth's error code for a failed change, in plain words. */
export function passwordChangeError(code: string | undefined): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "That isn't your current password.";
    case "PASSWORD_TOO_SHORT":
      return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
    case "PASSWORD_TOO_LONG":
      return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "This account has no password yet. Set one with pnpm owner:reset-password on the server.";
    case "UNAUTHORIZED":
      return "You were signed out. Sign in again, then change it.";
    default:
      return "The password wasn't changed. Try again.";
  }
}
