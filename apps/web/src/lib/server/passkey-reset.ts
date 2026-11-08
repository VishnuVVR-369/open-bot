import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sensitiveSessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { PASSKEY_RESET_MINUTES, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@open-bot/domain";

/**
 * A new password without the current one, for a session that has just proven a passkey.
 *
 * open-bot sends no email, so a forgotten password has no reset link. A passkey is a stronger
 * proof than the password it replaces, so a sign-in with one (with the device checking it's you:
 * Touch ID, a PIN) opens a short window, PASSKEY_RESET_MINUTES, in which that same session may set
 * a new password once. The window belongs to the session the passkey created, so a session from
 * an earlier sign-in, or a stolen cookie from one, can't use it. Setting the password closes the
 * window and signs out every other device, like changing it does.
 */

/** Passkey sign-ins in this request where the device verified the person, not just presence. */
const userVerified = new WeakSet<object>();

/** The passkey plugin's hook: remember that this sign-in verified the person. */
export function noteUserVerification({
  ctx,
  verification,
}: {
  ctx: { context: object };
  verification: { authenticationInfo: { userVerified: boolean } };
}) {
  if (verification.authenticationInfo.userVerified) userVerified.add(ctx.context);
}

const markerFor = (sessionId: string) => `passkey-reset:${sessionId}`;

type ResetContext = {
  newSession?: { session: { id: string }; user: { id: string } } | null;
  internalAdapter: {
    createVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<unknown>;
  };
};

/**
 * After a passkey sign-in: open the reset window for the session it created, but only when the
 * device verified the person. Presence alone (a tap on a key with no PIN) opens nothing.
 */
export async function openResetWindow(context: ResetContext, now = new Date()) {
  const created = context.newSession;
  if (!created || !userVerified.has(context)) return false;
  await context.internalAdapter.createVerificationValue({
    identifier: markerFor(created.session.id),
    value: created.user.id,
    expiresAt: new Date(now.getTime() + PASSKEY_RESET_MINUTES * 60_000),
  });
  return true;
}

export function passkeyReset() {
  return {
    id: "passkey-reset",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-authentication",
          handler: createAuthMiddleware(async (ctx) => {
            await openResetWindow(ctx.context);
          }),
        },
      ],
    },
    endpoints: {
      /** Whether this session may set a new password without the current one, and until when. */
      passkeyResetStatus: createAuthEndpoint(
        "/passkey-reset/status",
        { method: "GET", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const marker = await ctx.context.internalAdapter.findVerificationValue(
            markerFor(session.id),
          );
          const open = marker && marker.value === user.id && marker.expiresAt > new Date();
          return ctx.json({ ready: Boolean(open), until: open ? marker.expiresAt : null });
        },
      ),
      /** Set the new password, once, inside the window a passkey sign-in opened. */
      passkeyResetSetPassword: createAuthEndpoint(
        "/passkey-reset/set-password",
        {
          method: "POST",
          use: [sensitiveSessionMiddleware],
          body: z.object({ newPassword: z.string() }),
        },
        async (ctx) => {
          const { newPassword } = ctx.body;
          const { session, user } = ctx.context.session;
          // Checked before the window is used up, so a typo doesn't cost another passkey prompt.
          if (newPassword.length < PASSWORD_MIN_LENGTH)
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_SHORT",
              message: "Password too short",
            });
          if (newPassword.length > PASSWORD_MAX_LENGTH)
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_LONG",
              message: "Password too long",
            });
          const marker = await ctx.context.internalAdapter.consumeVerificationValue(
            markerFor(session.id),
          );
          if (!marker || marker.value !== user.id)
            throw new APIError("FORBIDDEN", {
              code: "PASSKEY_REQUIRED",
              message: "Confirm with your passkey first",
            });
          const hash = await ctx.context.password.hash(newPassword);
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (account)
            await ctx.context.internalAdapter.updateAccount(account.id, { password: hash });
          else
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: hash,
            });
          // Every other device signs out, as with a changed password; this one stays in.
          await ctx.context.internalAdapter.deleteUserSessions(user.id);
          const fresh = await ctx.context.internalAdapter.createSession(user.id);
          if (!fresh)
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Couldn't sign you back in" });
          await setSessionCookie(ctx, { session: fresh, user });
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
