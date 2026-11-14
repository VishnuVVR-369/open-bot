import { base, computer, id, ok } from "../base";
import { z } from "zod";
import {
  accountConnectInputSchema,
  accountConnectionChangesSchema,
  connectionInputSchema,
  emailSettingsInputSchema,
  emailStatusViewSchema,
} from "../../integrations";
import { connectionTestSchema, telegramStatusSchema } from "../views";

export const emailContract = {
  /** Mail Postmark delivered to a teammate's address; `token` is the secret in the URL. */
  inbound: base
    .route({
      method: "POST",
      path: "/internal/email/inbound/{token}",
      // The body is Postmark's payload as it came, so it isn't merged with the path.
      inputStructure: "detailed",
    })
    .input(z.object({ params: z.object({ token: z.string() }), body: z.unknown() }))
    .output(z.object({ ok: z.literal(true), botId: z.string().nullable() })),
  /** The domain, the inbound address and each teammate's address (makes the email row once). */
  status: base.route({ method: "GET", path: "/internal/email" }).output(emailStatusViewSchema),
  /** The domain teammates' addresses are on, and Postmark's token (empty keeps the saved one). */
  save: base
    .route({ method: "POST", path: "/internal/email" })
    .input(emailSettingsInputSchema)
    .output(ok),
  /** Forget Postmark's token: teammates receive email but can't send it. */
  removeToken: base.route({ method: "POST", path: "/internal/email/token/delete" }).output(ok),
};

export const connectionsContract = {
  /** Save an MCP server: a new one, or with `id`, a change to one. */
  save: base
    .route({ method: "POST", path: "/internal/connections" })
    .input(connectionInputSchema)
    .output(z.object({ id: z.string() })),
  /** Turn a connection on or off. Turning an account off cancels what waits on it. */
  setEnabled: base
    .route({ method: "POST", path: "/internal/connections/{connectionId}/enabled" })
    .input(z.object({ connectionId: id, enabled: z.boolean() }))
    .output(ok),
  /** Remove a connection; the last one using an account revokes it at the provider. */
  remove: base
    .route({ method: "POST", path: "/internal/connections/{connectionId}/delete" })
    .input(z.object({ connectionId: id }))
    .output(z.object({ warning: z.string().nullable() })),
  /** Change what an account connection allows, who uses it and how it asks. */
  updateAccount: base
    .route({ method: "POST", path: "/internal/connections/{connectionId}/account" })
    .input(accountConnectionChangesSchema)
    .output(z.object({ needsConsent: z.boolean() })),
  /**
   * You signed in to an account (the web app saved its grant): its connection of `kind`, made or
   * changed to what you picked. What waits on an earlier grant is cancelled.
   */
  linkAccount: base
    .route({ method: "POST", path: "/internal/accounts/{accountId}/linked" })
    .input(
      accountConnectInputSchema
        .pick({ kind: true, capabilities: true, teammateIds: true })
        .extend({ accountId: id }),
    )
    .output(z.object({ connectionId: z.string() })),
  /** Connect to an MCP server or account from the computer and list its tools. */
  test: computer
    .route({ method: "POST", path: "/internal/connections/{connectionId}/test" })
    .input(z.object({ connectionId: id }))
    .output(connectionTestSchema),
};

export const telegramContract = {
  status: base.route({ method: "GET", path: "/internal/telegram" }).output(telegramStatusSchema),
  connect: base
    .route({ method: "POST", path: "/internal/telegram/connect" })
    .input(z.object({ token: z.string().max(200) }))
    .output(telegramStatusSchema),
  /** A code to send the bot from the Telegram account to link. */
  linkCode: base
    .route({ method: "POST", path: "/internal/telegram/link-code" })
    .output(z.object({ code: z.string(), url: z.string(), expiresAt: z.string() })),
  sendTest: base.route({ method: "POST", path: "/internal/telegram/test" }).output(ok),
  unlink: base.route({ method: "POST", path: "/internal/telegram/unlink" }).output(ok),
  disconnect: base.route({ method: "POST", path: "/internal/telegram/disconnect" }).output(ok),
};
