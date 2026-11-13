import { z } from "zod";
import { base, id, ok } from "../base";
import {
  accountConnectInputSchema,
  accountConnectionChangesSchema,
  accountsSetupViewSchema,
  connectionInputSchema,
  connectionViewSchema,
  emailSettingsInputSchema,
  emailStatusViewSchema,
  oauthClientInputSchema,
} from "../integrations";
import { connectionTestSchema, telegramStatusSchema } from "../worker/views";

export const connectionsContract = {
  /** MCP servers and accounts teammates use, without their secrets. */
  list: base.output(z.array(connectionViewSchema)),
  /** Save an MCP server. Its headers and variables are encrypted and never sent back. */
  save: base.input(connectionInputSchema).output(z.object({ id: z.string() })),
  /** Turn a connection on or off. Turning an account off cancels what waits on it. */
  setEnabled: base.input(z.object({ connectionId: id, enabled: z.boolean() })).output(ok),
  /**
   * Remove a connection. The last connection using an account also revokes its access at the
   * provider; `warning` says when that couldn't be done.
   */
  remove: base
    .input(z.object({ connectionId: id }))
    .output(z.object({ warning: z.string().nullable() })),
  /** Connect to the service from the computer, and list what it offers. Wakes the computer. */
  test: base.input(z.object({ connectionId: id })).output(connectionTestSchema),
};

export const accountsContract = {
  /** What connecting an account needs, per provider, and the accounts signed in. */
  setup: base.output(accountsSetupViewSchema),
  /** Save the OAuth client you made in a provider's console, for new sign-ins to use. */
  saveClient: base.input(oauthClientInputSchema).output(ok),
  /**
   * Start connecting an account: returns the provider's sign-in page to go to, in this browser
   * (the sign-in is tied to this session).
   */
  connect: base.input(accountConnectInputSchema).output(z.object({ url: z.string() })),
  /**
   * Change what an account connection allows and who uses it. When it allows more than the
   * account granted, nothing changes and `needsConsent` says to sign in again for it.
   */
  update: base
    .input(accountConnectionChangesSchema)
    .output(z.object({ needsConsent: z.boolean() })),
};

export const emailContract = {
  status: base.output(emailStatusViewSchema),
  /** Your teammates' email domain and Postmark's server token, which sends what they write. */
  save: base.input(emailSettingsInputSchema).output(ok),
  /** Forget Postmark's token: teammates receive email but can't send it. */
  removeToken: base.output(ok),
};

export const telegramContract = {
  /** Fails with `SERVICE_UNAVAILABLE` while the worker can't be reached. */
  status: base.output(telegramStatusSchema),
  /** Connect Telegram with the token BotFather gave you. */
  connect: base.input(z.object({ token: z.string().max(200) })).output(telegramStatusSchema),
  /** A code to send from the Telegram account to link, and the chat link to send it in. */
  linkCode: base.output(z.object({ code: z.string(), url: z.string(), expiresAt: z.string() })),
  sendTest: base.output(ok),
  /** Forget the linked Telegram account; the token stays connected. */
  unlink: base.output(ok),
  disconnect: base.output(ok),
};
